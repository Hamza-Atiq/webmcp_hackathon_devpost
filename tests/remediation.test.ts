import { describe, it, expect } from "vitest";
import { Engine, SERVICE_NAMES, ACTION_KINDS, MAX_REPLICAS, restingHeapFor } from "../src/engine";
import {
  RECOVERY_ERROR_RATE,
  RECOVERY_P99_MS,
  SEV2_ERROR_RATE,
  TRAFFIC_SHIFT_MAX,
} from "../src/engine/constants";
import { meanOver } from "../src/engine/store";

/**
 * The five remediation actions — FR-9.
 *
 * The failure test for FR-9.2 is the one that matters: *if any action resolves any
 * incident regardless of cause, the entire premise of the product is void.* Scenario 1 is
 * the only mechanism that exists yet, so this file proves the claim for scenario 1 and
 * P5's matrix test extends it to the other four.
 */

function degraded(seed = 42): Engine {
  const engine = new Engine(seed);
  engine.advanceSeconds(60);
  engine.startScenario("s1");
  engine.advanceSeconds(180);
  return engine;
}

/**
 * A 30-second mean, never the latest second.
 *
 * One second of a 450 rps environment is a small enough sample that two identical runs
 * differ by several percentage points — which is exactly how an action that does nothing
 * gets read as an action that made things worse. An earlier draft of this file drew that
 * false conclusion about `shift_traffic` from single-second samples.
 */
function signals(engine: Engine, service = "checkout-service" as const) {
  return {
    errorRate: meanOver(engine.store, service, "errorRate", 30) ?? 0,
    p99: meanOver(engine.store, service, "p99", 30) ?? 0,
  };
}

function recovered(engine: Engine): boolean {
  const s = signals(engine);
  return s.errorRate <= RECOVERY_ERROR_RATE && s.p99 <= RECOVERY_P99_MS;
}

describe("only the action that addresses the mechanism fixes it — FR-9.2", () => {
  it("recovers scenario 1 on rollback and on nothing else", () => {
    for (const kind of ACTION_KINDS) {
      for (const seed of [42, 7]) {
        const engine = degraded(seed);
        expect(engine.remediate(kind, "checkout-service", {}, "agent").ok).toBe(true);
        engine.advanceSeconds(180);

        expect(recovered(engine), `${kind} at seed ${seed}`).toBe(kind === "rollback_deployment");
      }
    }
  });

  it("leaves the signals where they were when the action was irrelevant", () => {
    /*
     * Stronger than "did not recover": an irrelevant action must be indistinguishable
     * from having done nothing at all. Anything else is a hidden effect, and a hidden
     * effect in the wrong direction is how a matrix quietly stops being true.
     */
    const control = degraded();
    control.advanceSeconds(180);
    const baseline = signals(control);

    for (const kind of ["disable_feature_flag", "shift_traffic"] as const) {
      const engine = degraded();
      engine.remediate(kind, "checkout-service", {}, "agent");
      engine.advanceSeconds(180);

      const after = signals(engine);
      expect(Math.abs(after.errorRate - baseline.errorRate), kind).toBeLessThan(0.02);
      expect(Math.abs(after.p99 - baseline.p99), kind).toBeLessThan(150);
    }
  });

  it("does not let traffic shifting drain a queue it never touched", () => {
    /*
     * Shifted traffic is served elsewhere, against the same shared pool — it is not
     * deleted. When it *was* deleted, shift_traffic fully resolved scenario 1: a second
     * universal fix, which is exactly what FR-9.2's failure test forbids.
     */
    const engine = degraded();
    engine.remediate("shift_traffic", "checkout-service", { fraction: 0.9 }, "agent");
    engine.advanceSeconds(180);

    expect(recovered(engine)).toBe(false);
    // The service does serve less traffic — the shift is real, it just does not help here.
    const served = meanOver(engine.store, "checkout-service", "requests", 30) ?? 0;
    expect(served).toBeLessThan(200);
  });

  it("gives scale_replicas real relief without ever fixing it — FR-9.2, FR-9.2a", () => {
    /*
     * The interesting row of the matrix. Two actions look equally irrelevant to a
     * connection-pool regression, and the environment has to tell them apart on the
     * measurements alone: adding replicas divides the pool's queue between more workers,
     * while moving traffic to another instance leaves the same pool queueing the same
     * requests. One gives relief, the other gives nothing, and neither is a fix.
     *
     * Two seeds, on 30-second means. A single second of a 450 rps environment is small
     * enough to invent this effect where there is none, and it did once.
     */
    for (const seed of [42, 7]) {
      const control = degraded(seed);
      control.advanceSeconds(180);
      const before = signals(control);

      const scaled = degraded(seed);
      expect(scaled.remediate("scale_replicas", "checkout-service", {}, "agent").ok).toBe(true);
      scaled.advanceSeconds(180);

      // Relief, and far outside the noise: the contention errors go, the timeouts stay.
      expect(before.errorRate - signals(scaled).errorRate, `seed ${seed}`).toBeGreaterThan(0.02);
      expect(recovered(scaled), `seed ${seed}`).toBe(false);
    }
  });

  it("cannot be scaled into a fix at any replica count — FR-9.2a", () => {
    /*
     * The pool is shared at the service level, so replicas add workers and no
     * connections. If this ever passes, `scale_replicas` has become a second full fix
     * and FR-2.4c's "no action fixes more than two scenarios" is no longer protected by
     * the simulation.
     */
    const engine = degraded();
    expect(
      engine.remediate("scale_replicas", "checkout-service", { replicas: MAX_REPLICAS }, "agent").ok,
    ).toBe(true);
    engine.advanceSeconds(180);

    expect(recovered(engine)).toBe(false);
    expect(signals(engine).errorRate).toBeGreaterThan(SEV2_ERROR_RATE);
  });

  it("produces no instant recovery, even from the correct fix — FR-9.1", () => {
    const engine = degraded();
    engine.remediate("rollback_deployment", "checkout-service", {}, "agent");
    engine.advanceSeconds(5);

    expect(recovered(engine)).toBe(false);
  });
});

describe("every action is executable against every service", () => {
  it("never refuses for want of a target", () => {
    // AC-8's precondition: being refused teaches an agent nothing about its hypothesis,
    // while an action that runs and fails to help teaches it the hypothesis was wrong.
    for (const service of SERVICE_NAMES) {
      for (const kind of ACTION_KINDS) {
        const engine = degraded();
        const outcome = engine.remediate(kind, service, {}, "agent");
        expect(outcome.ok, `${kind} on ${service}: ${outcome.ok ? "" : outcome.error}`).toBe(true);
      }
    }
  });

  it("mints an action id, a before-snapshot and a timeline entry for each", () => {
    for (const kind of ACTION_KINDS) {
      const engine = degraded();
      const outcome = engine.remediate(kind, "checkout-service", {}, "agent");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;

      expect(outcome.action.id).toBe("act_0001");
      expect(outcome.action.kind).toBe(kind);
      expect(outcome.action.before["checkout-service"].errorRate).toBeGreaterThan(0);
      expect(engine.incident!.timeline.some((e) => e.message === outcome.action.summary)).toBe(true);
    }
  });
});

describe("parameters are clamped, not refused", () => {
  it("clamps a replica count outside the allowed range", () => {
    const engine = degraded();
    const outcome = engine.remediate("scale_replicas", "checkout-service", { replicas: 500 }, "agent");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.action.summary).toContain(`to ${MAX_REPLICAS} replicas`);
  });

  it("never shifts away all of a service's traffic", () => {
    /*
     * A service with no traffic has no signals, and an action that made an incident
     * unobservable rather than fixed would read as a recovery to any metric-based verdict.
     */
    const engine = degraded();
    const outcome = engine.remediate("shift_traffic", "checkout-service", { fraction: 1 }, "agent");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.action.summary).toContain(`${Math.round(TRAFFIC_SHIFT_MAX * 100)}%`);
    }
  });

  it("refuses an unknown feature flag by naming the real ones", () => {
    const engine = degraded();
    const outcome = engine.remediate(
      "disable_feature_flag",
      "checkout-service",
      { flag: "no_such_flag" },
      "agent",
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("no_such_flag");
      expect(outcome.error).toContain("checkout_v2_pricing");
    }
  });

  it("restarting clears the heap and costs errors while replicas cycle", () => {
    const engine = degraded();
    engine.world.services["checkout-service"].heapBytes = 400_000_000;

    engine.remediate("restart_service", "checkout-service", {}, "agent");

    // Back to rest, not to empty: a fresh process still holds its buffers and caches.
    // What matters for FR-9.3 is that whatever a leak accumulated is gone.
    const resting = restingHeapFor("checkout-service");
    expect(engine.world.services["checkout-service"].heapBytes).toBe(resting);
    expect(resting).toBeLessThan(400_000_000);

    // The cost is paid up front and is visible: a restart makes the signals worse first.
    engine.advanceSeconds(4);
    const during = meanOver(engine.store, "checkout-service", "errorRate", 3) ?? 0;

    const control = degraded();
    control.advanceSeconds(4);
    const baseline = meanOver(control.store, "checkout-service", "errorRate", 3) ?? 0;

    expect(during).toBeGreaterThan(baseline);
  });
});
