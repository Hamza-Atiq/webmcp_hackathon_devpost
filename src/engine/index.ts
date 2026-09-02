import { TICKS_PER_SIM_SECOND } from "./constants";
import { createWorld, scheduleConfigChange, type World } from "./world";
import { createStore, latestMetric, type Store } from "./store";
import { createSim, tick, type Sim } from "./sim";
import { addTimelineEntry, setIncidentStatus } from "./incident";
import { findRunbooks, runbookById, type Runbook } from "./runbooks";
import { ownershipFor, type Ownership } from "./ownership";
import { seedBaselineHistory } from "./deployments";
import { onset as s1Onset } from "./scenarios/s1";
import type { Incident, IncidentStatus, MetricPoint, ServiceName, TimelineEntry } from "./types";

/**
 * The engine's public interface.
 *
 * Deliberately framework-free and DOM-free: the WebMCP tool layer and the React UI both
 * call this, and so do the tests. Keeping it that way is what lets the outcome matrix in
 * FR-9.2 be verified headlessly in seconds rather than by hand in a browser.
 */

export type ScenarioId = "s1";

export interface EngineOptions {
  /**
   * Start a scenario automatically once the simulated clock reaches `atMs` (FR-5.1).
   *
   * Owned by the engine rather than by the render loop, and checked after every single
   * tick. The driver decides how many ticks a frame consumes, so a check made once per
   * frame would fire up to 300 ticks late at 60x and the scenario would begin at a
   * different simulated moment depending on the speed — breaking FR-3.4 outright.
   * Inside the tick loop the onset lands on the same tick at every speed.
   */
  autoStart?: { id: ScenarioId; atMs: number };
}

export class Engine {
  readonly world: World;
  readonly store: Store;
  private readonly sim: Sim;
  private pending: { id: ScenarioId; atMs: number } | null;

  constructor(seed = 20260904, options: EngineOptions = {}) {
    this.world = createWorld(seed);
    this.store = createStore();
    this.sim = createSim(this.world, this.store);
    this.pending = options.autoStart ?? null;
    seedBaselineHistory(this.world);
  }

  /** Advance the world by whole ticks. The only way simulated time moves. */
  advanceTicks(n: number): void {
    for (let i = 0; i < n; i++) {
      tick(this.sim);

      if (this.pending && this.world.nowMs >= this.pending.atMs) {
        const { id } = this.pending;
        this.pending = null;
        this.startScenario(id);
      }
    }
  }

  /** Is a scenario still waiting to begin on its own? Drives the manual trigger's label. */
  get scenarioPending(): boolean {
    return this.pending !== null;
  }

  /** Convenience for tests and for the healthy warm-up window. */
  advanceSeconds(seconds: number): void {
    this.advanceTicks(Math.round(seconds * TICKS_PER_SIM_SECOND));
  }

  /**
   * Begin a scenario now, cancelling any scheduled start — FR-5.2.
   *
   * The manual trigger and the automatic onset run the same code path, so a judge who
   * skips the wait sees exactly the incident that would have arrived anyway.
   */
  startScenario(id: ScenarioId): void {
    this.pending = null;
    if (id === "s1") s1Onset(this.world);
  }

  health(service: ServiceName): MetricPoint | null {
    return latestMetric(this.store, service);
  }

  /** The open incident record, or null while the environment is healthy. */
  get incident(): Incident | null {
    return this.world.incident;
  }

  /**
   * Move the incident through its lifecycle (FR-5.4), recording who did it.
   * Refuses with an explanation rather than throwing, because both the UI and the
   * tool layer surface the reason to whoever tried.
   */
  setIncidentStatus(
    status: IncidentStatus,
    actor: TimelineEntry["actor"],
  ): { ok: true } | { ok: false; error: string } {
    return setIncidentStatus(this.world, status, actor);
  }

  /** Written procedures, retrievable by symptom or service — FR-4.5. */
  runbooks(query?: string, service?: ServiceName): Runbook[] {
    return findRunbooks(query, service);
  }

  runbook(id: string): Runbook | undefined {
    return runbookById(id);
  }

  /** Owning team and current on-call — FR-4.6. */
  ownership(service: ServiceName): Ownership {
    return ownershipFor(service);
  }

  /** Append an observation to the incident timeline — FR-5.5. */
  recordTimelineEntry(actor: TimelineEntry["actor"], message: string): void {
    addTimelineEntry(this.world, actor, message);
  }

  /**
   * Roll a service back to its previous deployment.
   *
   * Reverses the configuration the deployment introduced, over the normal rollout ramp,
   * so recovery is progressive rather than instant (FR-9.1). Returns false when there is
   * nothing eligible to roll back.
   */
  rollback(service: ServiceName, actor: TimelineEntry["actor"] = "human"): boolean {
    const deployments = this.world.deployments
      .filter((d) => d.service === service && !d.rolledBack)
      .sort((a, b) => b.t - a.t);

    const latest = deployments[0];
    if (!latest || !latest.previousVersion) return false;

    for (const change of latest.diff) {
      if (change.key === "DB_POOL_MAX") {
        scheduleConfigChange(this.world, service, "dbPoolMax", Number(change.from));
      }
    }

    latest.rolledBack = true;

    // FR-5.5: a remediation belongs on the incident timeline with its actor.
    addTimelineEntry(
      this.world,
      actor,
      `Rolled back ${service} from ${latest.version} to ${latest.previousVersion} ` +
        `(deployment ${latest.id}).`,
    );
    return true;
  }
}

export { SERVICE_NAMES } from "./world";
export { classifySeverity, isBreaching, isRecovered, STATUS_ORDER } from "./incident";
export { RUNBOOKS, findRunbooks, runbookById } from "./runbooks";
export { OWNERSHIP, ownershipFor } from "./ownership";
export type { Runbook } from "./runbooks";
export type { Ownership } from "./ownership";
export type {
  Deployment,
  Incident,
  IncidentStatus,
  LogEntry,
  MetricPoint,
  ServiceName,
  ServiceState,
  Severity,
  Span,
  TimelineEntry,
  Trace,
} from "./types";
