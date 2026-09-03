import { describe, it, expect } from "vitest";
import { ACTION_KINDS, Engine, SCENARIO_IDS, type ActionKind, type ScenarioId } from "../src/engine";
import { RECOVERY_ERROR_RATE, RECOVERY_P99_MS } from "../src/engine/constants";
import { meanOver } from "../src/engine/store";
import { invokeTool } from "../src/mcp/register";
import { resetSession, session } from "../src/session";
import type { ServiceName, Span } from "../src/engine";

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

/**
 * `flag` names the flag the action is given, because an agent has to choose one and the
 * choice is part of the remediation. `disable_feature_flag` with no argument would fall
 * to whichever flag happens to be listed first, which tests the list order rather than
 * the mechanism.
 */
const EXPECTED: Record<
  ScenarioId,
  {
    service: ServiceName;
    flag: string;
    outcomes: Partial<Record<ActionKind, Outcome>>;
  }
> = {
  s1: {
    service: "checkout-service",
    flag: "checkout_v2_pricing",
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
    flag: "stock_reservation_v2",
    outcomes: {
      rollback_deployment: "full",
      scale_replicas: "partial",
      disable_feature_flag: "none",
      shift_traffic: "none",
    },
  },
  s3: {
    service: "payment-service",
    flag: "payment_fraud_check_v2",
    outcomes: {
      disable_feature_flag: "full",
      shift_traffic: "partial",
      rollback_deployment: "none",
      restart_service: "none",
      scale_replicas: "none",
    },
  },
  /*
   * The only "worse" in the matrix, and the reason the classifier has that outcome at all.
   */
  s4: {
    service: "user-service",
    flag: "user_profile_schema_v2",
    outcomes: {
      disable_feature_flag: "full",
      shift_traffic: "partial",
      scale_replicas: "worse",
      rollback_deployment: "none",
      restart_service: "none",
    },
  },
  s5: {
    service: "checkout-service",
    flag: "checkout_v2_pricing",
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
    const { service, flag, outcomes } = EXPECTED[id];

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
          const params = action === "disable_feature_flag" ? { flag } : {};
          expect(treated.remediate(action, service, params, "agent").ok).toBe(true);
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
 * FR-2.4c — an agent with a favourite action cannot exceed a 40% success rate.
 *
 * Asserted over the expectations rather than over a run, because it is a claim about the
 * shape of the scenario library and not about any one incident. It is what stops the five
 * scenarios from collapsing into one exercise repeated five times: whatever an agent
 * learned last incident, it is wrong at least three times in five.
 */
describe("no action is the answer more than twice — FR-2.4c", () => {
  it("holds across the whole library", () => {
    const fixes: Partial<Record<ActionKind, number>> = {};

    for (const id of SCENARIO_IDS) {
      for (const [action, outcome] of Object.entries(EXPECTED[id].outcomes)) {
        if (outcome === "full") fixes[action as ActionKind] = (fixes[action as ActionKind] ?? 0) + 1;
      }
    }

    // Every scenario has exactly one full fix, or the library has a hole in it.
    const totalFixes = Object.values(fixes).reduce((sum, n) => sum + n, 0);
    expect(totalFixes).toBe(SCENARIO_IDS.length);

    for (const [action, count] of Object.entries(fixes)) {
      expect(count, `${action} fixes ${count} scenarios`).toBeLessThanOrEqual(2);
    }
  });
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

/**
 * FR-4.3, FR-4.8 — a trace has to blame the span that actually failed.
 *
 * Written after a live trace was found carrying an error on `db.acquire_connection` for a
 * request that died at an external provider, with the database working perfectly. An
 * agent reading that would blame the pool, and would be right to, because the evidence
 * said so. Evidence that points at the wrong subsystem is worse than no evidence.
 */
describe("a failed span is the span that failed — FR-4.3", () => {
  it("blames the provider in scenario 3 and the pool in scenario 1", () => {
    const cases: Array<{ id: ScenarioId; service: ServiceName; span: string; innocent: string }> = [
      {
        id: "s3",
        service: "payment-service",
        span: "external.fraud_score",
        innocent: "db.acquire_connection",
      },
      {
        id: "s1",
        service: "checkout-service",
        span: "db.acquire_connection",
        innocent: "app.handler",
      },
    ];

    for (const { id, service, span, innocent } of cases) {
      const engine = degraded(42, id);
      const failures = engine.store.traces.filter(
        (trace) => trace.service === service && trace.status === "error",
      );
      expect(failures.length, `${id} produced no failed traces`).toBeGreaterThan(0);

      const blamed = failures.filter((trace) =>
        flatten(trace.root).some((s) => s.name === span && s.error !== undefined),
      );
      expect(blamed.length, `${id}: no failed trace blames ${span}`).toBeGreaterThan(0);

      for (const trace of blamed) {
        const wrong = flatten(trace.root).find(
          (s) => s.name === innocent && s.error !== undefined,
        );
        expect(wrong, `${id}: ${trace.id} blames ${innocent} as well`).toBeUndefined();
      }
    }
  });
});

function flatten(span: Span): Span[] {
  return [span, ...span.children.flatMap(flatten)];
}

/**
 * FR-2.5 — no tool response, at any time, discloses the active scenario.
 *
 * Swept over every scenario and every read-only tool, because the requirement is about
 * the whole surface and a single leak anywhere voids it. It is easy to add one by
 * accident: a log line that names the mechanism, a runbook ranked so highly it can only
 * mean one thing, a summary written for the developer rather than the reader.
 *
 * What is forbidden is a *label* — the scenario's id or a name for its category. Symptoms
 * are not leaks: "pool exhausted" is what the environment measured, and an agent that
 * reasons from it is doing the work rather than being told the answer.
 */
describe("no tool response names the scenario — FR-2.5", () => {
  const FORBIDDEN = [
    ...SCENARIO_IDS,
    "scenario 1",
    "scenario 2",
    "scenario 3",
    "scenario 4",
    "scenario 5",
    "config regression",
    "resource exhaustion",
    "dependency failure",
    "bad migration",
    "capacity scenario",
  ];

  it("holds for every read-only tool in every scenario", async () => {
    for (const id of SCENARIO_IDS) {
      resetSession();
      const { engine } = session();
      engine.advanceSeconds(30);
      engine.startScenario(id);
      engine.advanceSeconds(180);

      const service = engine.incident?.affectedServices[0] ?? "checkout-service";
      const calls: Array<[string, Record<string, unknown>]> = [
        ["list_services", {}],
        ["get_service_health", { service }],
        ["get_metrics", { service, metric: "p99" }],
        ["search_logs", { service, limit: 20 }],
        ["list_traces", { service, limit: 10 }],
        ["list_recent_deployments", { service }],
        ["get_runbook", { symptom: "latency" }],
        ["get_service_ownership", { service }],
        ["get_incident", {}],
      ];

      for (const [tool, args] of calls) {
        const result = await invokeTool(tool, args, { source: "webmcp", actor: "agent" });
        const text = JSON.stringify(result).toLowerCase();

        for (const term of FORBIDDEN) {
          expect(
            text.includes(term.toLowerCase()),
            `${id}: ${tool} disclosed "${term}"`,
          ).toBe(false);
        }
      }
    }
  });
});
