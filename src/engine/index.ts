import { TICKS_PER_SIM_SECOND } from "./constants";
import { createWorld, scheduleConfigChange, type World } from "./world";
import { createStore, latestMetric, type Store } from "./store";
import { createSim, tick, type Sim } from "./sim";
import { addTimelineEntry, setIncidentStatus } from "./incident";
import { onset as s1Onset, seedHistory as s1SeedHistory } from "./scenarios/s1";
import type { Incident, IncidentStatus, MetricPoint, ServiceName, TimelineEntry } from "./types";

/**
 * The engine's public interface.
 *
 * Deliberately framework-free and DOM-free: the WebMCP tool layer and the React UI both
 * call this, and so do the tests. Keeping it that way is what lets the outcome matrix in
 * FR-9.2 be verified headlessly in seconds rather than by hand in a browser.
 */

export type ScenarioId = "s1";

export class Engine {
  readonly world: World;
  readonly store: Store;
  private readonly sim: Sim;

  constructor(seed = 20260904) {
    this.world = createWorld(seed);
    this.store = createStore();
    this.sim = createSim(this.world, this.store);
    s1SeedHistory(this.world);
  }

  /** Advance the world by whole ticks. The only way simulated time moves. */
  advanceTicks(n: number): void {
    for (let i = 0; i < n; i++) tick(this.sim);
  }

  /** Convenience for tests and for the healthy warm-up window. */
  advanceSeconds(seconds: number): void {
    this.advanceTicks(Math.round(seconds * TICKS_PER_SIM_SECOND));
  }

  startScenario(id: ScenarioId): void {
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
export type {
  Incident,
  IncidentStatus,
  MetricPoint,
  ServiceName,
  Severity,
  TimelineEntry,
} from "./types";
