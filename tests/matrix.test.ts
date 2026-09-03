import { describe, it, expect } from "vitest";
import { ACTION_KINDS, Engine, SCENARIO_IDS, type ActionKind, type ScenarioId } from "../src/engine";
import { RECOVERY_ERROR_RATE, RECOVERY_P99_MS } from "../src/engine/constants";
import { meanOver } from "../src/engine/store";
import type { ServiceName } from "../src/engine";

/**
 * FR-9.2 — the outcome matrix, measured rather than asserted.
 *
 * The matrix is mandatory and is written down in exactly one place: this file, as the
 * expectation. It exists nowhere in `src/`, and that is the point. Every outcome below is
 * produced by arithmetic over configuration the actions change — a lookup keyed on
 * (scenario, action) would make FR-2.5 unenforceable and AC-7 circular, because the
 * environment would be agreeing with the agent by construction.
 *
 * Read a failure here as "the physics no longer produce the behaviour the product
 * promises", not as "the expectation is out of date".
 */

type Outcome = "full" | "partial" | "none" | "worse";

/** Beyond these, two runs differ because the action did something — not because of noise. */
const ERROR_BAND = 0.02;
const P99_BAND = 150;

const EXPECTED: Record<
  ScenarioId,
  { service: ServiceName; outcomes: Partial<Record<ActionKind, Outcome>> }
> = {
  s1: {
    service: "checkout-service",
    outcomes: {
      rollback_deployment: "full",
      scale_replicas: "partial",
      disable_feature_flag: "none",
      shift_traffic: "none",
    },
  },
  s5: {
    service: "checkout-service",
    outcomes: {
      scale_replicas: "full",
      shift_traffic: "partial",
      rollback_deployment: "none",
      restart_service: "none",
      disable_feature_flag: "none",
    },
  },
};

function degraded(seed: number, id: ScenarioId): Engine {
  const engine = new Engine(seed);
  engine.advanceSeconds(30);
  engine.startScenario(id);
  engine.advanceSeconds(180);
  return engine;
}

/** Thirty-second means. A single second of a 450 rps environment invents effects. */
function signals(engine: Engine, service: ServiceName) {
  return {
    errorRate: meanOver(engine.store, service, "errorRate", 30) ?? 0,
    p99: meanOver(engine.store, service, "p99", 30) ?? 0,
  };
}

function classify(
  before: { errorRate: number; p99: number },
  after: { errorRate: number; p99: number },
): Outcome {
  const recovered = after.errorRate <= RECOVERY_ERROR_RATE && after.p99 <= RECOVERY_P99_MS;
  if (recovered) return "full";

  const errorDelta = before.errorRate - after.errorRate;
  const p99Delta = before.p99 - after.p99;

  if (errorDelta > ERROR_BAND || p99Delta > P99_BAND) return "partial";
  if (errorDelta < -ERROR_BAND || p99Delta < -P99_BAND) return "worse";
  return "none";
}

describe("the outcome matrix falls out of the physics — FR-9.2", () => {
  for (const id of SCENARIO_IDS) {
    const { service, outcomes } = EXPECTED[id];

    for (const action of ACTION_KINDS) {
      const expected = outcomes[action];
      if (!expected) continue;

      it(`${id}: ${action} is ${expected}`, () => {
        /*
         * Two seeds, because one is a sample and the matrix is a claim about the
         * mechanism. An outcome that holds on one seed and not the other is noise being
         * read as physics, which this suite has done before.
         */
        for (const seed of [42, 7]) {
          const control = degraded(seed, id);
          control.advanceSeconds(180);
          const before = signals(control, service);

          const treated = degraded(seed, id);
          expect(treated.remediate(action, service, {}, "agent").ok).toBe(true);
          treated.advanceSeconds(180);

          expect(classify(before, signals(treated, service)), `${id} ${action} seed ${seed}`).toBe(
            expected,
          );
        }
      });
    }
  }
});
