import { meanOver, type Store } from "./store";
import { nextId, SERVICE_NAMES, type World } from "./world";
import type { ServiceName, TimelineEntry } from "./types";

/**
 * The ledger of actions that have actually been applied to the environment.
 *
 * FR-10.1a: every applied action — agent-initiated or human-initiated — returns an
 * `action_id` and stores the state it was applied against. Without that, "did it work?"
 * has no fixed point to measure from: an agent asking after two remediations, or after
 * the human clicked rollback in the dashboard, would be comparing against whatever it
 * happened to have read earlier. The ledger makes "before the action" unambiguous.
 *
 * Note what is *not* stored: nothing about whether the action was expected to help.
 * The verdict in FR-10.2 is computed from measured metrics against the FR-0 recovery
 * thresholds, so recording an intention here would only invite reading it back out.
 */

/** FR-9's names, exactly. These strings are the tool contract. */
export type ActionKind =
  | "rollback_deployment"
  | "restart_service"
  | "scale_replicas"
  | "disable_feature_flag"
  | "shift_traffic";

/** One service's signals at the moment an action was applied. */
export interface ServiceSnapshot {
  errorRate: number;
  p99: number;
  p50: number;
}

export interface AppliedAction {
  id: string;
  /** Simulated ms at which it was applied. */
  t: number;
  kind: ActionKind;
  service: ServiceName;
  actor: TimelineEntry["actor"];
  /** What was done, in the words shown to a human. Never why, and never a prediction. */
  summary: string;
  /** The record acted on — a deployment id for a rollback — when there is one. */
  target: string | null;
  /**
   * Every service, not just the target. An action on one service moves signals on the
   * services that call it, and which of those matter differs by scenario; snapshotting
   * all five costs nothing and avoids guessing now which ones a later scenario needs.
   */
  before: Record<ServiceName, ServiceSnapshot>;
}

/**
 * Seconds averaged into a snapshot.
 *
 * A single second is noisy enough that a before/after comparison could show improvement
 * that never happened. Five seconds is the same window severity classification uses, for
 * the same reason.
 */
const SNAPSHOT_WINDOW_SEC = 5;

function snapshot(store: Store, service: ServiceName): ServiceSnapshot {
  return {
    errorRate: meanOver(store, service, "errorRate", SNAPSHOT_WINDOW_SEC) ?? 0,
    p99: meanOver(store, service, "p99", SNAPSHOT_WINDOW_SEC) ?? 0,
    p50: meanOver(store, service, "p50", SNAPSHOT_WINDOW_SEC) ?? 0,
  };
}

export function recordAction(
  world: World,
  store: Store,
  action: Omit<AppliedAction, "id" | "t" | "before">,
): AppliedAction {
  const before = {} as Record<ServiceName, ServiceSnapshot>;
  for (const name of SERVICE_NAMES) before[name] = snapshot(store, name);

  const applied: AppliedAction = {
    ...action,
    id: nextId(world, "act"),
    t: world.nowMs,
    before,
  };
  world.actions.push(applied);
  return applied;
}

/** The action a bare `verify_remediation` call verifies — FR-10.1a. */
export function mostRecentAction(world: World): AppliedAction | null {
  return world.actions.length > 0 ? world.actions[world.actions.length - 1]! : null;
}

export function actionById(world: World, id: string): AppliedAction | undefined {
  return world.actions.find((a) => a.id === id);
}
