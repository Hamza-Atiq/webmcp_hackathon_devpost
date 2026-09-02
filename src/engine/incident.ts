import {
  INCIDENT_ERROR_RATE_THRESHOLD,
  INCIDENT_P99_THRESHOLD_MS,
  INCIDENT_SUSTAIN_SEC,
  RECOVERY_ERROR_RATE,
  RECOVERY_P99_MS,
  RECOVERY_SUSTAIN_SEC,
  SEV1_ERROR_RATE,
  SEV2_ERROR_RATE,
  SEV2_P99_MS,
  SEVERITY_WINDOW_SEC,
} from "./constants";
import { meanOver, type Store } from "./store";
import { nextId, SERVICE_NAMES, type World } from "./world";
import type {
  Incident,
  IncidentStatus,
  MetricPoint,
  ServiceName,
  Severity,
  TimelineEntry,
} from "./types";

/**
 * Incident detection, severity and lifecycle.
 *
 * This module reads measurements and nothing else. It never learns which scenario is
 * running, and there is no table anywhere mapping a scenario to the severity it "should"
 * open at — severity is arithmetic on the signals the simulation actually produced
 * (FR-5.3, AC-5a). Scenario 1 opens at SEV-2 not because s1.ts says so, but because a
 * pool of 5 connections cannot serve 112 database requests a second.
 *
 * Consequently the same code detects all five scenarios, and a scenario whose mechanism
 * were mis-calibrated would visibly open at the wrong severity rather than lying.
 */

/** Severity as a comparable rank, so "the worst affected service" is a max, not a lookup. */
const SEVERITY_RANK: Record<Severity, number> = {
  "SEV-3": 1,
  "SEV-2": 2,
  "SEV-1": 3,
};

/** The lifecycle order of FR-5.4. Used to describe a move, never to forbid going back. */
export const STATUS_ORDER: IncidentStatus[] = [
  "detected",
  "investigating",
  "identified",
  "mitigating",
  "resolved",
];

/** One second of a service's signals, as the detector sees them. */
export interface ServiceSignals {
  errorRate: number;
  p99: number;
  requests: number;
  errors: number;
}

/**
 * Is this service breaching the incident thresholds right now?
 *
 * Evaluated on the raw per-second point rather than a smoothed average, because FR-0
 * defines the trigger as a condition holding for 15 *consecutive* seconds — the run
 * length is itself the noise filter, and smoothing first would filter twice.
 */
export function isBreaching(s: ServiceSignals): boolean {
  return s.errorRate > INCIDENT_ERROR_RATE_THRESHOLD || s.p99 > INCIDENT_P99_THRESHOLD_MS;
}

/** Is this service back inside the FR-0 recovery thresholds for this second? */
export function isRecovered(s: ServiceSignals): boolean {
  return s.errorRate <= RECOVERY_ERROR_RATE && s.p99 <= RECOVERY_P99_MS;
}

/**
 * Severity implied by a set of signals, or null when they are below the incident
 * threshold entirely. Straight from the FR-0 table, in order of decreasing seriousness.
 */
export function classifySeverity(s: ServiceSignals): Severity | null {
  const servingNothing = s.requests > 0 && s.errors >= s.requests;
  if (s.errorRate > SEV1_ERROR_RATE || servingNothing) return "SEV-1";
  if (s.errorRate > SEV2_ERROR_RATE || s.p99 > SEV2_P99_MS) return "SEV-2";
  if (isBreaching(s)) return "SEV-3";
  return null;
}

/**
 * Signals smoothed over the last few seconds, used only for *classifying* severity.
 *
 * Detection uses raw seconds; classification uses a short mean, so a single unlucky
 * second cannot escalate an incident to SEV-1 and leave that escalation on the record
 * permanently. Returns null when there is no data for the service yet.
 */
function smoothedSignals(
  store: Store,
  service: ServiceName,
  latest: MetricPoint,
): ServiceSignals {
  const errorRate = meanOver(store, service, "errorRate", SEVERITY_WINDOW_SEC) ?? latest.errorRate;
  const p99 = meanOver(store, service, "p99", SEVERITY_WINDOW_SEC) ?? latest.p99;
  return { errorRate, p99, requests: latest.requests, errors: latest.errors };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(value: number): string {
  return `${Math.round(value)} ms`;
}

/** A symptom description. Deliberately never names a cause — that is the agent's job (FR-2.5). */
function describeSignals(service: ServiceName, s: ServiceSignals): string {
  return `${service}: error rate ${pct(s.errorRate)}, p99 ${ms(s.p99)}`;
}

export function addTimelineEntry(
  world: World,
  actor: TimelineEntry["actor"],
  message: string,
): void {
  if (!world.incident) return;
  world.incident.timeline.push({ t: world.nowMs, actor, message });
}

/**
 * Move the incident to a new status.
 *
 * Movement is not restricted to forward steps: a failed verification legitimately sends
 * an incident from `mitigating` back to `investigating` (spec S5), and refusing that
 * would force a lie into the record. The one hard gate is FR-10.4 — `resolved` is
 * unreachable until the signals have actually sustained recovery.
 */
export function setIncidentStatus(
  world: World,
  status: IncidentStatus,
  actor: TimelineEntry["actor"],
): { ok: true } | { ok: false; error: string } {
  const incident = world.incident;
  if (!incident) return { ok: false, error: "No incident is currently open." };

  if (incident.status === status) {
    return { ok: false, error: `Incident ${incident.id} is already ${status}.` };
  }

  if (incident.status === "resolved") {
    return { ok: false, error: `Incident ${incident.id} is resolved and cannot be reopened.` };
  }

  if (status === "resolved" && incident.recoveryVerifiedAt === null) {
    return {
      ok: false,
      error:
        `Incident ${incident.id} cannot be resolved: verification has not passed. ` +
        `Recovery requires error rate <= ${pct(RECOVERY_ERROR_RATE)} and p99 <= ` +
        `${ms(RECOVERY_P99_MS)} sustained for ${RECOVERY_SUSTAIN_SEC} seconds on every ` +
        `affected service.`,
    };
  }

  const from = incident.status;
  incident.status = status;
  if (status === "resolved") incident.resolvedAt = world.nowMs;

  addTimelineEntry(world, actor, `Status changed from ${from} to ${status}.`);
  return { ok: true };
}

function openIncident(
  world: World,
  breaching: Array<{ service: ServiceName; signals: ServiceSignals }>,
): void {
  let severity: Severity = "SEV-3";
  let worst = breaching[0]!;

  for (const candidate of breaching) {
    const implied = classifySeverity(candidate.signals);
    if (implied && SEVERITY_RANK[implied] > SEVERITY_RANK[severity]) {
      severity = implied;
      worst = candidate;
    }
  }

  const affected = breaching.map((b) => b.service).sort();

  const incident: Incident = {
    id: nextId(world, "inc"),
    openedAt: world.nowMs,
    severity,
    status: "detected",
    affectedServices: affected,
    title: `Elevated error rate and latency on ${worst.service}`,
    openingSignals: {
      service: worst.service,
      errorRate: worst.signals.errorRate,
      p99: worst.signals.p99,
    },
    recoveryVerifiedAt: null,
    timeline: [],
    resolvedAt: null,
  };

  world.incident = incident;

  addTimelineEntry(
    world,
    "system",
    `Incident opened at ${severity}. Thresholds breached for ` +
      `${INCIDENT_SUSTAIN_SEC}s on ${affected.join(", ")}. ` +
      `${describeSignals(worst.service, worst.signals)}.`,
  );
}

/**
 * Evaluate detection, severity and recovery for one finalised simulated second.
 *
 * Called from tick() once per simulated second, after that second's metrics are stored.
 * Draws no random numbers, so it cannot perturb the replay (FR-1.5).
 */
export function evaluateIncident(
  world: World,
  store: Store,
  points: Partial<Record<ServiceName, MetricPoint>>,
): void {
  const breaching: Array<{ service: ServiceName; signals: ServiceSignals }> = [];

  for (const name of SERVICE_NAMES) {
    const point = points[name];
    // A service that served nothing this second reports nothing. Its counters hold
    // rather than reset, so a silent service neither triggers nor clears an incident.
    if (!point) continue;

    const raw: ServiceSignals = {
      errorRate: point.errorRate,
      p99: point.p99,
      requests: point.requests,
      errors: point.errors,
    };

    if (isBreaching(raw)) {
      world.breachSec[name] += 1;
      breaching.push({ service: name, signals: smoothedSignals(store, name, point) });
    } else {
      world.breachSec[name] = 0;
    }

    world.recoverySec[name] = isRecovered(raw) ? world.recoverySec[name] + 1 : 0;
  }

  const incident = world.incident;

  if (!incident) {
    const sustained = breaching.filter((b) => world.breachSec[b.service] >= INCIDENT_SUSTAIN_SEC);
    if (sustained.length > 0) openIncident(world, sustained);
    return;
  }

  if (incident.status === "resolved") return;

  // A service that starts breaching after the incident opened joins it, and stays on
  // the record afterwards — an incident's blast radius is a history, not a live view.
  for (const { service } of breaching) {
    if (!incident.affectedServices.includes(service)) {
      incident.affectedServices.push(service);
      incident.affectedServices.sort();
      addTimelineEntry(world, "system", `${service} is now breaching incident thresholds.`);
    }
  }

  // Severity escalates as things get worse and never quietly de-escalates: an incident
  // that reached SEV-1 was a SEV-1, and downgrading the badge mid-recovery would erase
  // that from the record the postmortem is built from.
  for (const { service, signals } of breaching) {
    const implied = classifySeverity(signals);
    if (implied && SEVERITY_RANK[implied] > SEVERITY_RANK[incident.severity]) {
      const from = incident.severity;
      incident.severity = implied;
      addTimelineEntry(
        world,
        "system",
        `Severity escalated from ${from} to ${implied}. ${describeSignals(service, signals)}.`,
      );
    }
  }

  if (incident.recoveryVerifiedAt === null) {
    const sustainedRecovery = incident.affectedServices.every(
      (name) => world.recoverySec[name] >= RECOVERY_SUSTAIN_SEC,
    );
    if (sustainedRecovery) {
      incident.recoveryVerifiedAt = world.nowMs;
      addTimelineEntry(
        world,
        "system",
        `Signals have held inside recovery thresholds for ${RECOVERY_SUSTAIN_SEC}s on all ` +
          `affected services. The incident may now be resolved.`,
      );
    }
  }
}
