import { describe, it, expect } from "vitest";
import { Engine } from "../src/engine";
import {
  HEALTHY_ERROR_RATE,
  HEALTHY_P50_MS,
  HEALTHY_P95_MS,
  HEALTHY_P99_MS,
  RECOVERY_ERROR_RATE,
  RECOVERY_P99_MS,
  SEV2_ERROR_RATE,
  SEV2_P99_MS,
} from "../src/engine/constants";

/**
 * P1 exit criterion: the pool mechanism produces a healthy baseline inside every FR-0
 * threshold, degrades when the configuration regresses, and genuinely recovers when the
 * change is reversed — all as arithmetic, with no fixture anywhere.
 */

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Average a signal over the last `seconds` of checkout metrics. */
function recent(engine: Engine, field: "errorRate" | "p50" | "p95" | "p99", seconds: number) {
  const series = engine.store.metrics["checkout-service"].slice(-seconds);
  return mean(series.map((p) => p[field]));
}

describe("scenario 1 — connection pool regression", () => {
  it("holds a healthy baseline inside every FR-0 threshold", () => {
    const engine = new Engine(42);
    engine.advanceSeconds(90);

    expect(recent(engine, "errorRate", 60)).toBeLessThanOrEqual(HEALTHY_ERROR_RATE);
    expect(recent(engine, "p50", 60)).toBeLessThanOrEqual(HEALTHY_P50_MS);
    expect(recent(engine, "p95", 60)).toBeLessThanOrEqual(HEALTHY_P95_MS);
    expect(recent(engine, "p99", 60)).toBeLessThanOrEqual(HEALTHY_P99_MS);
  });

  it("degrades to SEV-2 once the pool regression rolls out", () => {
    const engine = new Engine(42);
    engine.advanceSeconds(60);
    engine.startScenario("s1");
    engine.advanceSeconds(180);

    expect(recent(engine, "errorRate", 60)).toBeGreaterThan(SEV2_ERROR_RATE);
    expect(recent(engine, "p99", 60)).toBeGreaterThan(SEV2_P99_MS);
  });

  it("recovers after the deployment is rolled back", () => {
    const engine = new Engine(42);
    engine.advanceSeconds(60);
    engine.startScenario("s1");
    engine.advanceSeconds(180);

    expect(engine.rollback("checkout-service")).toBe(true);
    engine.advanceSeconds(180);

    expect(recent(engine, "errorRate", 30)).toBeLessThanOrEqual(RECOVERY_ERROR_RATE);
    expect(recent(engine, "p99", 30)).toBeLessThanOrEqual(RECOVERY_P99_MS);
  });

  it("blames the connection wait, not the query, in the traces", () => {
    const engine = new Engine(42);
    engine.advanceSeconds(60);
    engine.startScenario("s1");
    engine.advanceSeconds(180);

    const slow = engine.store.traces
      .filter((t) => t.service === "checkout-service" && t.durationMs > 1000)
      .slice(-20);

    expect(slow.length).toBeGreaterThan(0);

    // The evidence has to point at the pool: time is spent acquiring a connection,
    // not running the query. This is the correlation the agent is meant to find.
    for (const trace of slow) {
      const acquire = trace.root.children.find((s) => s.name === "db.acquire_connection");
      const query = trace.root.children.find((s) => s.name === "db.query");
      expect(acquire).toBeDefined();
      expect(query).toBeDefined();
      expect(acquire!.durationMs).toBeGreaterThan(query!.durationMs);
    }
  });

  it("is reproducible from the seed", () => {
    const run = () => {
      const engine = new Engine(7);
      engine.advanceSeconds(60);
      engine.startScenario("s1");
      engine.advanceSeconds(120);
      return engine.store.metrics["checkout-service"].map((p) => `${p.p99}|${p.errorRate}`);
    };

    expect(run()).toEqual(run());
  });
});
