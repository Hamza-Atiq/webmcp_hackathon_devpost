import { describe, it, expect } from "vitest";
import { Engine } from "../src/engine";
import { RECOVERY_ERROR_RATE } from "../src/engine/constants";

/**
 * FR-10.1a — every applied action mints an `action_id` and stores the state it was
 * applied against, whoever applied it.
 *
 * The clause exists so that "did it work?" has a fixed point to measure from. These
 * tests are therefore written against that property rather than against the shape of
 * the record: a snapshot taken a moment too late, or after a second remediation, is
 * still a well-formed record and still destroys the comparison it exists to support.
 */

function degradedAndRolledBack(seconds = 180, seed = 42) {
  const engine = new Engine(seed);
  engine.advanceSeconds(60);
  engine.startScenario("s1");
  engine.advanceSeconds(seconds);
  return engine;
}

describe("the applied-action ledger", () => {
  it("mints an id for a human rollback, not only an agent one — FR-10.1a", () => {
    const engine = degradedAndRolledBack();
    const applied = engine.rollback("checkout-service", "human");

    expect(applied).not.toBeNull();
    expect(applied!.id).toBe("act_0001");
    expect(applied!.actor).toBe("human");
    expect(applied!.kind).toBe("rollback_deployment");
    expect(applied!.target).toMatch(/^dep_/);
  });

  it("snapshots the degraded state the action was applied against, not the recovered one", () => {
    const engine = degradedAndRolledBack();
    const applied = engine.rollback("checkout-service", "human")!;

    // Taken at the moment of application: the incident is open and signals are bad.
    expect(applied.before["checkout-service"].errorRate).toBeGreaterThan(RECOVERY_ERROR_RATE);

    // Let the fix land completely.
    engine.advanceSeconds(240);
    const now = engine.health("checkout-service")!;
    expect(now.errorRate).toBeLessThanOrEqual(RECOVERY_ERROR_RATE);

    // The snapshot must still describe the state *before* the fix. If it were taken
    // lazily, or by reference to live state, this is where it would read as recovered
    // and every verification verdict would be measured against the wrong baseline.
    expect(applied.before["checkout-service"].errorRate).toBeGreaterThan(RECOVERY_ERROR_RATE);
  });

  it("snapshots every service, so an action's effect on its callers is measurable too", () => {
    const engine = degradedAndRolledBack();
    const applied = engine.rollback("checkout-service", "human")!;

    for (const service of ["api-gateway", "checkout-service", "user-service"] as const) {
      expect(applied.before[service]).toBeDefined();
      expect(Number.isFinite(applied.before[service].p99)).toBe(true);
    }
  });

  it("logs each rollback that executes, and records nothing once history runs out", () => {
    const engine = degradedAndRolledBack();

    /*
     * Rolling back twice is not a no-op: the second walks further back into the baseline
     * history FR-2.4a seeds, which executes and simply does not help. That path is the
     * one AC-8 depends on, so it earns an action id like any other applied action.
     */
    const applied = [];
    for (let i = 0; i < 5; i++) {
      const result = engine.rollback("checkout-service", "human");
      if (result === null) break;
      applied.push(result);
    }

    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(engine.actions).toHaveLength(applied.length);

    // With the history exhausted there is no target left, and a refused attempt must not
    // enter the ledger — `verify_remediation` would otherwise default to verifying a
    // rollback that never happened.
    expect(engine.rollback("checkout-service", "human")).toBeNull();
    expect(engine.actions).toHaveLength(applied.length);
  });

  it("defaults to the most recent action and finds any action by id", () => {
    const engine = degradedAndRolledBack();
    const first = engine.rollback("checkout-service", "human")!;
    engine.advanceSeconds(10);
    const second = engine.rollback("payment-service", "agent")!;

    expect(second.id).toBe("act_0002");
    expect(engine.lastAction!.id).toBe(second.id);
    expect(engine.action(first.id)!.service).toBe("checkout-service");
    expect(engine.action("act_9999")).toBeUndefined();
  });

  it("keeps action ids deterministic across identical runs — FR-1.5", () => {
    const a = degradedAndRolledBack(180, 7);
    const b = degradedAndRolledBack(180, 7);

    const one = a.rollback("checkout-service", "human")!;
    const two = b.rollback("checkout-service", "human")!;

    expect(one.id).toBe(two.id);
    expect(one.t).toBe(two.t);
    expect(one.before).toEqual(two.before);
  });
});
