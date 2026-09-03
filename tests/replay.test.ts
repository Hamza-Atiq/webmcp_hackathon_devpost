import { describe, it, expect } from "vitest";
import { Engine, SCENARIO_IDS, type ScenarioId } from "../src/engine";
import { HEALTHY_WINDOW_MS, TICKS_PER_SIM_SECOND } from "../src/engine/constants";
import { SERVICE_NAMES } from "../src/engine/world";

/**
 * FR-3.4 and AC-12 — the speed multiplier changes the *rate* at which simulated events
 * occur and never their sequence or their values.
 *
 * This was previously "true by construction and never checked". Writing it caught a real
 * bug: the render loop decides how many ticks a frame consumes, and the scenario onset was
 * being applied after that whole batch. At 1x a frame is under one tick, so onset landed on
 * time; at 60x a frame is four ticks and onset landed up to a second late, so the same run
 * at two speeds produced different evidence. The schedule now lives inside the engine and is
 * checked after every tick.
 */

/**
 * Run the standard arc, consuming `ticksPerBatch` ticks per call — the only thing the speed
 * multiplier actually varies. 1 stands for 1x, 4 for 10x, 240 for 60x, and 300 is the
 * driver's per-frame ceiling after a backgrounded tab.
 */
function runInBatches(ticksPerBatch: number, seed = 42, scenario: ScenarioId = "s1"): Engine {
  const engine = new Engine(seed, { autoStart: { id: scenario, atMs: HEALTHY_WINDOW_MS } });
  const totalTicks = 240 * TICKS_PER_SIM_SECOND;

  let done = 0;
  while (done < totalTicks) {
    const batch = Math.min(ticksPerBatch, totalTicks - done);
    engine.advanceTicks(batch);
    done += batch;
  }
  return engine;
}

/** Everything an agent or a judge could observe, flattened for comparison. */
function evidence(engine: Engine): string {
  return JSON.stringify({
    now: engine.world.nowMs,
    metrics: SERVICE_NAMES.map((name) =>
      engine.store.metrics[name].map((p) => [p.t, p.requests, p.errors, p.p50, p.p95, p.p99]),
    ),
    logs: engine.store.logs.map((l) => [l.id, l.t, l.service, l.level, l.message, l.correlationId]),
    traces: engine.store.traces.map((t) => [t.id, t.t, t.service, t.durationMs, t.status]),
    deployments: engine.world.deployments.map((d) => [d.id, d.t, d.version, d.rolledBack]),
    incident: engine.incident,
  });
}

describe("speed independence — FR-3.4", () => {
  it("produces byte-identical evidence at every tick batch size", () => {
    const oneX = evidence(runInBatches(1));

    for (const batch of [4, 24, 240, 300]) {
      expect(evidence(runInBatches(batch)), `batch size ${batch}`).toEqual(oneX);
    }
  });

  it("starts the scenario on the same tick whatever the batch size", () => {
    // The regression this test exists for: onset applied per frame rather than per tick.
    for (const batch of [1, 4, 240, 300]) {
      const engine = runInBatches(batch);
      const onset = engine.world.deployments.find((d) => d.version === "v2.4.1")!;
      expect(onset.t, `batch size ${batch}`).toBe(HEALTHY_WINDOW_MS);
    }
  });

  it("opens the incident at the same simulated moment whatever the batch size", () => {
    const openedAt = runInBatches(1).incident!.openedAt;
    for (const batch of [4, 24, 240, 300]) {
      expect(runInBatches(batch).incident!.openedAt, `batch size ${batch}`).toBe(openedAt);
    }
  });

  it("holds across seeds, so the match is not a coincidence of one run", () => {
    for (const seed of [1, 7, 20260904]) {
      expect(evidence(runInBatches(240, seed))).toEqual(evidence(runInBatches(1, seed)));
    }
  });

  /*
   * Every scenario, not just the one this test was written for.
   *
   * Each mechanism carries state across ticks — a pool queue, a heap, a provider queue, a
   * lock wait that depends on the replica count — and any of them could have introduced a
   * dependency on how many ticks a batch happens to contain. Scenario 1 passing says
   * nothing about the other four, and a judge running any of them twice must see the same
   * story (AC-12).
   */
  it("holds for all five scenarios, whose mechanisms carry different state", () => {
    for (const scenario of SCENARIO_IDS) {
      const oneX = evidence(runInBatches(1, 42, scenario));
      for (const batch of [4, 240, 300]) {
        expect(
          evidence(runInBatches(batch, 42, scenario)),
          `${scenario} at batch size ${batch}`,
        ).toEqual(oneX);
      }
    }
  });

  it("opens every scenario's incident at the same simulated moment at any batch size", () => {
    for (const scenario of SCENARIO_IDS) {
      const openedAt = runInBatches(1, 42, scenario).incident?.openedAt;
      expect(openedAt, `${scenario} opened no incident at all`).toBeDefined();

      for (const batch of [4, 240, 300]) {
        expect(
          runInBatches(batch, 42, scenario).incident?.openedAt,
          `${scenario} at batch size ${batch}`,
        ).toBe(openedAt);
      }
    }
  });

  /*
   * The determinism claim a judge actually makes: reload the page, run it again, get the
   * same incident. Two engines built the same way with no shared state must agree on
   * every observable, which is a different property from batch independence — that one is
   * about the driver, this one is about the seed.
   */
  it("replays identically from a fresh engine, which is what reloading the page does", () => {
    for (const scenario of SCENARIO_IDS) {
      expect(
        evidence(runInBatches(4, 20260904, scenario)),
        `${scenario} differed between two identical runs`,
      ).toEqual(evidence(runInBatches(4, 20260904, scenario)));
    }
  });
});

describe("manual trigger — FR-5.2", () => {
  it("starts the scenario immediately, bypassing the healthy window", () => {
    const engine = new Engine(42, { autoStart: { id: "s1", atMs: HEALTHY_WINDOW_MS } });
    engine.advanceSeconds(3);
    expect(engine.scenarioPending).toBe(true);

    engine.startScenario("s1");
    expect(engine.scenarioPending).toBe(false);

    const onset = engine.world.deployments.find((d) => d.version === "v2.4.1")!;
    expect(onset.t).toBe(3000);
  });

  it("does not start the scenario a second time when the schedule comes due", () => {
    const engine = new Engine(42, { autoStart: { id: "s1", atMs: HEALTHY_WINDOW_MS } });
    engine.advanceSeconds(3);
    engine.startScenario("s1");
    engine.advanceSeconds(120);

    const onsets = engine.world.deployments.filter((d) => d.version === "v2.4.1");
    expect(onsets).toHaveLength(1);
  });
});

describe("rollback is always executable — FR-2.4a", () => {
  it("every service has a prior version to roll back to", () => {
    // AC-8 depends on this: rollback must be executable everywhere and simply not help,
    // because being refused for want of a target would teach the agent nothing.
    for (const service of SERVICE_NAMES) {
      const engine = new Engine(42);
      engine.advanceSeconds(30);
      expect(engine.rollback(service, "human"), service).not.toBeNull();
    }
  });

  it("rolls back a deployment that predates the incident on untouched services", () => {
    const engine = new Engine(42, { autoStart: { id: "s1", atMs: HEALTHY_WINDOW_MS } });
    engine.advanceSeconds(180);

    const target = engine.world.deployments
      .filter((d) => d.service === "payment-service" && !d.rolledBack)
      .sort((a, b) => b.t - a.t)[0]!;

    // An agent can see for itself that this predates the degradation (FR-2.4a).
    expect(target.t).toBeLessThan(0);
    const applied = engine.rollback("payment-service", "agent");
    expect(applied).not.toBeNull();
    expect(applied!.target).toBe(target.id);
  });
});
