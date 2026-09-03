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

interface Signals {
  errorRate: number;
  p99: number;
}

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
  /*
   * `restart_service` is absent here exactly as it is absent from FR-9.2's row: it is
   * neither relief nor nothing, it is relief that expires. FR-9.3 is asserted on its own,
   * where the shape over time can be measured instead of a single endpoint.
   */
  s2: {
    service: "inventory-service",
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

const WINDOW_SEC = 180;

/** Where the environment ended up. Thirty-second means; a single second invents effects. */
function settled(engine: Engine, service: ServiceName) {
  return {
    errorRate: meanOver(engine.store, service, "errorRate", 30) ?? 0,
    p99: meanOver(engine.store, service, "p99", 30) ?? 0,
  };
}

/**
 * What the environment was like across the whole window after the action.
 *
 * Relief is not always permanent, and an endpoint comparison cannot see the kind that
 * is not: adding replicas to a leaking service dilutes the heap across new processes and
 * buys real time, and three minutes later the leak has taken it back. Judged on the last
 * thirty seconds that action reads as doing nothing, which is false — it did something
 * and then the leak undid it. Judged across the window it reads as relief, which is what
 * FR-9.2 calls it and what an operator experienced.
 */
function across(engine: Engine, service: ServiceName) {
  return {
    errorRate: meanOver(engine.store, service, "errorRate", WINDOW_SEC) ?? 0,
    p99: meanOver(engine.store, service, "p99", WINDOW_SEC) ?? 0,
  };
}

function classify(
  control: { settled: Signals; across: Signals },
  treated: { settled: Signals; across: Signals },
): Outcome {
  const recovered =
    treated.settled.errorRate <= RECOVERY_ERROR_RATE && treated.settled.p99 <= RECOVERY_P99_MS;
  if (recovered) return "full";

  const errorDelta = control.across.errorRate - treated.across.errorRate;
  const p99Delta = control.across.p99 - treated.across.p99;

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
          control.advanceSeconds(WINDOW_SEC);

          const treated = degraded(seed, id);
          expect(treated.remediate(action, service, {}, "agent").ok).toBe(true);
          treated.advanceSeconds(WINDOW_SEC);

          const outcome = classify(
            { settled: settled(control, service), across: across(control, service) },
            { settled: settled(treated, service), across: across(treated, service) },
          );
          expect(outcome, `${id} ${action} seed ${seed}`).toBe(expected);
        }
      });
    }
  }
});

/**
 * FR-9.3 — relief that expires.
 *
 * The matrix above has four columns and none of them fits `restart_service` on a leaking
 * service: it is not a fix, it is not nothing, and calling it partial relief would hide
 * the only thing about it worth knowing. What makes it dangerous is that it *looks* like
 * a fix for a minute, which is long enough for someone to close the incident and go home.
 *
 * So it is asserted as a shape over time rather than as an endpoint, and it emerges from
 * the same arithmetic as everything else: the restart empties the heap, the leaking build
 * is still deployed, and the heap fills again.
 */
describe("restarting a leaking service is relief that expires — FR-9.3", () => {
  it("recovers, then degrades again with nothing else changed", () => {
    const service: ServiceName = "inventory-service";
    const engine = degraded(42, "s2");
    const before = signalsOf(engine, service, 30);
    expect(before.errorRate).toBeGreaterThan(RECOVERY_ERROR_RATE);

    expect(engine.remediate("restart_service", service, {}, "agent").ok).toBe(true);

    engine.advanceSeconds(45);
    const soonAfter = signalsOf(engine, service, 30);
    expect(soonAfter.errorRate, "the restart bought real time").toBeLessThan(
      before.errorRate / 2,
    );

    engine.advanceSeconds(240);
    const later = signalsOf(engine, service, 30);
    expect(later.errorRate, "and the leak took it back").toBeGreaterThan(before.errorRate / 2);

    // The distinction has to be observable in the metrics, which is FR-9.3's own words.
    expect(later.errorRate).toBeGreaterThan(soonAfter.errorRate);
  });
});

function signalsOf(engine: Engine, service: ServiceName, seconds: number): Signals {
  return {
    errorRate: meanOver(engine.store, service, "errorRate", seconds) ?? 0,
    p99: meanOver(engine.store, service, "p99", seconds) ?? 0,
  };
}
