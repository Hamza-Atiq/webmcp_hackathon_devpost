import { describe, it, expect } from "vitest";
import { Engine } from "../src/engine";
import { findRunbooks, RUNBOOKS } from "../src/engine/runbooks";
import { OWNERSHIP } from "../src/engine/ownership";
import { SERVICE_NAMES } from "../src/engine/world";

/**
 * The evidence sources added for P3: runbooks (FR-4.5), ownership (FR-4.6) and the
 * log-to-trace correlation ids (FR-4.2).
 *
 * The correlation assertions exist because the browser found what the tests had not: 96% of
 * correlation ids pointed at traces already evicted from the ring buffer, so an agent following
 * one would have got nothing back. These assert the link resolves inside the window an
 * investigation actually uses.
 */

function degraded(seconds: number, seed = 42): Engine {
  const engine = new Engine(seed);
  engine.advanceSeconds(60);
  engine.startScenario("s1");
  engine.advanceSeconds(seconds);
  return engine;
}

describe("runbook library", () => {
  it("covers failure modes that are not active, so retrieval is not an oracle", () => {
    // With one runbook, get_runbook would identify the scenario outright.
    expect(RUNBOOKS.length).toBeGreaterThanOrEqual(5);
    const ids = RUNBOOKS.map((r) => r.id);
    expect(ids).toContain("rb_pool_exhaustion");
    expect(ids).toContain("rb_memory_pressure");
    expect(ids).toContain("rb_dependency_timeout");
    expect(ids).toContain("rb_lock_contention");
    expect(ids).toContain("rb_capacity_saturation");
  });

  it("never names this incident's culprit — FR-2.5", () => {
    const text = JSON.stringify(RUNBOOKS).toLowerCase();
    for (const giveaway of ["db_pool_max", "v2.4.1", "dep_0003", "d.okafor", "scenario 1"]) {
      expect(text).not.toContain(giveaway);
    }
  });

  it("finds the pool procedure from the symptom an engineer would actually type", () => {
    for (const query of ["pool exhausted", "waiters", "acquire", "gateway timeout"]) {
      const found = findRunbooks(query).map((r) => r.id);
      expect(found, `query: ${query}`).toContain("rb_pool_exhaustion");
    }
  });

  it("returns the general procedure rather than nothing for an unknown symptom", () => {
    const found = findRunbooks("purple monday sadness");
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("rb_latency_triage");
  });
});

describe("ownership", () => {
  it("covers every service", () => {
    for (const name of SERVICE_NAMES) {
      expect(OWNERSHIP[name].service).toBe(name);
      expect(OWNERSHIP[name].id).toBe(`own_${name}`);
      expect(OWNERSHIP[name].onCall.length).toBeGreaterThan(0);
    }
  });

  it("names the deployment author as the owning team's on-call, so the trail joins up", () => {
    const engine = degraded(60);
    const deploy = engine.world.deployments.find((d) => d.version === "v2.4.1")!;
    expect(OWNERSHIP["checkout-service"].onCall).toBe(deploy.author);
  });
});

describe("log to trace correlation", () => {
  it("emits correlated error logs without drowning the pool evidence", () => {
    const engine = degraded(180);
    const logs = engine.store.logs;
    const correlated = logs.filter((l) => l.correlationId);
    const pool = logs.filter((l) => l.message.includes("pool exhausted"));

    expect(correlated.length).toBeGreaterThan(0);
    // The saturation lines are what explains the incident. They must not be outnumbered by
    // per-request failure noise — measured at 853 correlated against 138 pool lines before
    // the per-second budget was cut.
    expect(pool.length).toBeGreaterThanOrEqual(correlated.length);
  });

  it("every correlation id resolves to a real trace inside the investigation window", () => {
    for (const seed of [1, 42, 7, 20260904]) {
      const engine = degraded(180, seed);
      const traceIds = new Set(engine.store.traces.map((t) => t.id));
      const correlated = engine.store.logs.filter((l) => l.correlationId);

      expect(correlated.length).toBeGreaterThan(0);
      const broken = correlated.filter((l) => !traceIds.has(l.correlationId!));
      expect(broken.map((l) => `${l.id}->${l.correlationId}`)).toEqual([]);
    }
  });

  it("points at a trace from the same service and the same moment", () => {
    const engine = degraded(180);
    const byId = new Map(engine.store.traces.map((t) => [t.id, t]));

    for (const log of engine.store.logs.filter((l) => l.correlationId)) {
      const trace = byId.get(log.correlationId!)!;
      expect(trace.service).toBe(log.service);
      expect(trace.t).toBe(log.t);
      expect(trace.status).toBe("error");
    }
  });

  it("does not log routine background failures as incidents", () => {
    // A healthy service returning the odd 500 is not news. Logged every second, every
    // service would look like it were in trouble.
    const engine = new Engine(42);
    engine.advanceSeconds(120);
    const healthyCorrelated = engine.store.logs.filter(
      (l) => l.correlationId && l.service === "payment-service",
    );
    expect(healthyCorrelated).toEqual([]);
  });
});
