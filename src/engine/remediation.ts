import { recordAction, type ActionKind, type AppliedAction } from "./actions";
import { RESTART_MS, ROLLOUT_MS, TRAFFIC_SHIFT_MAX } from "./constants";
import { flagByKey } from "./flags";
import { addTimelineEntry } from "./incident";
import type { Store } from "./store";
import type { ServiceName, TimelineEntry } from "./types";
import { scheduleConfigChange, type World } from "./world";

/**
 * The five remediation actions — FR-9.
 *
 * **One implementation, called by both paths.** A human clicking "Restart service" and an
 * agent executing an approved proposal arrive here with the same parameters (FR-12.2).
 * If the agent's route went through code the human's did not, the two would drift and the
 * product's central claim — that this is one system a human and an agent operate together
 * — would quietly stop being true.
 *
 * **Every action is executable against every service, always** (the principle behind
 * FR-2.4a, applied across the board). Nothing here refuses for want of a target: a refusal
 * tells an agent nothing about its hypothesis, while an action that runs and fails to help
 * tells it the hypothesis was wrong. That distinction is what FR-9.2's matrix is made of,
 * and AC-8 depends on it directly.
 *
 * **Nothing here knows which scenario is active, or which action is "correct".** Each
 * writes configuration and the consequences fall out of the simulation (FR-1.4). The
 * outcome matrix is a property of the physics, not a table consulted at execution time —
 * if any of these functions ever needed to know the scenario, FR-9.2 would be a lie.
 */

export interface RemediationParams {
  /** `scale_replicas` — the new replica count. */
  replicas?: number;
  /** `disable_feature_flag` — which flag to turn off. */
  flag?: string;
  /** `shift_traffic` — the share of traffic to route away, 0 to 0.9. */
  fraction?: number;
}

export type RemediationOutcome =
  | { ok: true; action: AppliedAction }
  | { ok: false; error: string };

export const BLAST_RADIUS: Record<ActionKind, "LOW" | "MEDIUM" | "HIGH"> = {
  rollback_deployment: "HIGH",
  restart_service: "MEDIUM",
  scale_replicas: "LOW",
  disable_feature_flag: "MEDIUM",
  shift_traffic: "HIGH",
};

export const ACTION_KINDS: ActionKind[] = [
  "rollback_deployment",
  "restart_service",
  "scale_replicas",
  "disable_feature_flag",
  "shift_traffic",
];

/** Clamp to the declared range rather than refusing — the caller still wants the action. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const MIN_REPLICAS = 1;
export const MAX_REPLICAS = 10;

export function applyRemediation(
  world: World,
  store: Store,
  kind: ActionKind,
  service: ServiceName,
  params: RemediationParams,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  switch (kind) {
    case "rollback_deployment":
      return rollbackDeployment(world, store, service, actor);
    case "restart_service":
      return restartService(world, store, service, actor);
    case "scale_replicas":
      return scaleReplicas(world, store, service, params, actor);
    case "disable_feature_flag":
      return disableFeatureFlag(world, store, service, params, actor);
    case "shift_traffic":
      return shiftTraffic(world, store, service, params, actor);
  }
}

function rollbackDeployment(
  world: World,
  store: Store,
  service: ServiceName,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  const latest = world.deployments
    .filter((d) => d.service === service && !d.rolledBack)
    .sort((a, b) => b.t - a.t)[0];

  if (!latest || !latest.previousVersion) {
    return {
      ok: false,
      error:
        `No deployment left to roll back on ${service} — its history is exhausted. ` +
        `list_recent_deployments shows what remains.`,
    };
  }

  /*
   * The snapshot is taken before the change is scheduled, so "before the action" is the
   * state it was applied against rather than one already moving under it (FR-10.1a).
   */
  const action = recordAction(world, store, {
    kind: "rollback_deployment",
    service,
    actor,
    summary:
      `Rolled back ${service} from ${latest.version} to ${latest.previousVersion} ` +
      `(deployment ${latest.id}).`,
    target: latest.id,
  });

  for (const change of latest.diff) {
    if (change.key === "DB_POOL_MAX") {
      scheduleConfigChange(world, service, "dbPoolMax", Number(change.from));
    }
  }
  latest.rolledBack = true;

  return finish(world, action, actor);
}

function restartService(
  world: World,
  store: Store,
  service: ServiceName,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  const state = world.services[service];

  const action = recordAction(world, store, {
    kind: "restart_service",
    service,
    actor,
    summary: `Restarted ${service}. Process state cleared; in-flight requests failed.`,
    target: null,
  });

  /*
   * A rolling restart, not a stop-the-world one. Replicas cycle one at a time, so a share
   * of requests fails while each comes back rather than all of them — which is both what
   * production does and what makes FR-9.3's "temporary relief" observable later: the heap
   * is genuinely cleared, and in a leaking service it simply starts filling again.
   */
  state.heapBytes = 0;
  state.waiters = 0;
  state.connectionsInUse = 0;
  state.startedAtMs = world.nowMs;
  state.restartingUntilMs = world.nowMs + RESTART_MS;

  return finish(world, action, actor);
}

function scaleReplicas(
  world: World,
  store: Store,
  service: ServiceName,
  params: RemediationParams,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  const current = Math.round(world.services[service].config.replicas);
  const requested = Number.isFinite(params.replicas) ? Number(params.replicas) : current + 3;
  const target = Math.round(clamp(requested, MIN_REPLICAS, MAX_REPLICAS));

  const action = recordAction(world, store, {
    kind: "scale_replicas",
    service,
    actor,
    summary: `Scaled ${service} from ${current} to ${target} replicas.`,
    target: null,
  });

  // Replicas arrive over the rollout ramp, like any other capacity change (FR-9.1).
  scheduleConfigChange(world, service, "replicas", target, ROLLOUT_MS);

  return finish(world, action, actor);
}

function disableFeatureFlag(
  world: World,
  store: Store,
  service: ServiceName,
  params: RemediationParams,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  const key = typeof params.flag === "string" ? params.flag : null;
  const flag = key
    ? flagByKey(world, key)
    : world.flags.find((f) => f.service === service && f.enabled);

  if (!flag) {
    const known = world.flags
      .filter((f) => f.service === service)
      .map((f) => f.key)
      .join(", ");
    return {
      ok: false,
      error: key
        ? `Unknown feature flag ${JSON.stringify(key)}. Flags on ${service}: ${known || "none"}.`
        : `No enabled feature flag on ${service}. Flags there: ${known || "none"}.`,
    };
  }

  const action = recordAction(world, store, {
    kind: "disable_feature_flag",
    service: flag.service,
    actor,
    summary: `Disabled feature flag ${flag.key} on ${flag.service}.`,
    target: flag.key,
  });

  flag.enabled = false;

  return finish(world, action, actor);
}

function shiftTraffic(
  world: World,
  store: Store,
  service: ServiceName,
  params: RemediationParams,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  const requested = Number.isFinite(params.fraction) ? Number(params.fraction) : 0.5;
  const fraction = clamp(requested, 0, TRAFFIC_SHIFT_MAX);
  const state = world.services[service];

  const action = recordAction(world, store, {
    kind: "shift_traffic",
    service,
    actor,
    summary: `Shifted ${Math.round(fraction * 100)}% of traffic away from ${service}.`,
    target: null,
  });

  /*
   * Load balancers move traffic quickly, so this is not ramped — but it still cannot
   * produce instant recovery (FR-9.1), because the queue that built up while the service
   * was saturated has to drain through the mechanism at its own pace.
   */
  state.trafficShiftedAway = fraction;

  return finish(world, action, actor);
}

/** FR-5.5 — a remediation belongs on the incident timeline with its actor. */
function finish(
  world: World,
  action: AppliedAction,
  actor: TimelineEntry["actor"],
): RemediationOutcome {
  addTimelineEntry(world, actor, action.summary);
  return { ok: true, action };
}
