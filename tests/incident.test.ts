import { describe, it, expect } from "vitest";
import { Engine } from "../src/engine";
import { classifySeverity, isBreaching, isRecovered } from "../src/engine/incident";
import {
  INCIDENT_SUSTAIN_SEC,
  RECOVERY_ERROR_RATE,
  RECOVERY_P99_MS,
  RECOVERY_SUSTAIN_SEC,
} from "../src/engine/constants";

/**
 * FR-5 (incident lifecycle), AC-5a (severity is measured, not stored) and FR-10.4
 * (resolution is gated on verification).
 *
 * The severity assertions here are deliberately not "scenario 1 opens at SEV-2 because
 * that is what scenario 1 does". They assert that the severity matches what the stored
 * metrics independently imply — so a mis-calibrated mechanism fails the test rather than
 * quietly passing it.
 */

/** Run the standard arc: healthy window, then scenario 1, then `seconds` of degradation. */
function degraded(seconds: number, seed = 42): Engine {
  const engine = new Engine(seed);
  engine.advanceSeconds(60);
  engine.startScenario("s1");
  engine.advanceSeconds(seconds);
  return engine;
}

describe("threshold classification", () => {
  it("reads the FR-0 severity table off the signals", () => {
    expect(classifySeverity({ errorRate: 0.005, p99: 180, requests: 400, errors: 2 })).toBeNull();
    expect(classifySeverity({ errorRate: 0.03, p99: 900, requests: 400, errors: 12 })).toBe("SEV-3");
    expect(classifySeverity({ errorRate: 0.01, p99: 1400, requests: 400, errors: 4 })).toBe("SEV-3");
    expect(classifySeverity({ errorRate: 0.08, p99: 900, requests: 400, errors: 32 })).toBe("SEV-2");
    expect(classifySeverity({ errorRate: 0.01, p99: 4200, requests: 400, errors: 4 })).toBe("SEV-2");
    expect(classifySeverity({ errorRate: 0.4, p99: 5000, requests: 400, errors: 160 })).toBe("SEV-1");
  });

  it("treats a service serving no successful requests as SEV-1 whatever its error rate reads", () => {
    expect(classifySeverity({ errorRate: 1, p99: 3000, requests: 50, errors: 50 })).toBe("SEV-1");
  });

  it("separates the incident threshold from the recovery threshold", () => {
    const healthy = { errorRate: 0.004, p99: 190, requests: 450, errors: 2 };
    expect(isBreaching(healthy)).toBe(false);
    expect(isRecovered(healthy)).toBe(true);

    // The gap between them is deliberate: a service can stop breaching without yet
    // being recovered, which is what makes "partial relief" a real outcome (FR-0).
    const middling = { errorRate: 0.015, p99: 700, requests: 450, errors: 7 };
    expect(isBreaching(middling)).toBe(false);
    expect(isRecovered(middling)).toBe(false);
  });
});

describe("incident detection", () => {
  it("stays quiet while the environment is healthy", () => {
    const engine = new Engine(42);
    engine.advanceSeconds(120);
    expect(engine.incident).toBeNull();
  });

  it("does not open on a breach shorter than the sustain window", () => {
    const engine = new Engine(42);
    engine.advanceSeconds(60);
    engine.startScenario("s1");
    engine.advanceSeconds(5);
    expect(engine.incident).toBeNull();
  });

  it("opens an incident automatically once degradation sustains", () => {
    const engine = degraded(180);
    const incident = engine.incident;

    expect(incident).not.toBeNull();
    expect(incident!.id).toBe("inc_0001");
    expect(incident!.status).toBe("detected");
    expect(incident!.affectedServices).toContain("checkout-service");
  });

  it("opens no earlier than the sustain window allows", () => {
    const engine = degraded(180);
    const onsetMs = 60_000;

    // The pool change ramps over the rollout window, so the breach starts some way
    // after onset — but it can never be detected in under INCIDENT_SUSTAIN_SEC.
    const elapsedSec = (engine.incident!.openedAt - onsetMs) / 1000;
    expect(elapsedSec).toBeGreaterThanOrEqual(INCIDENT_SUSTAIN_SEC);
  });

  it("reaches SEV-2, and the stored metrics independently say the same thing", () => {
    const engine = degraded(240);
    const incident = engine.incident!;

    expect(incident.severity).toBe("SEV-2");

    // AC-5a: the severity is not taken on trust. Check it against the FR-0 table
    // written out literally, applied to the metric series the tools would return.
    // Calling classifySeverity() here instead would only prove the classifier agrees
    // with itself — the assertion has to restate the spec independently.
    const series = engine.store.metrics["checkout-service"].slice(-5);
    const mean = (f: "errorRate" | "p99") =>
      series.reduce((sum, p) => sum + p[f], 0) / series.length;

    const errorRate = mean("errorRate");
    const p99 = mean("p99");

    // FR-0, transcribed: SEV-1 above 25% errors; SEV-2 above 5% errors or 3000ms p99.
    expect(errorRate).toBeLessThanOrEqual(0.25);
    expect(errorRate > 0.05 || p99 > 3000).toBe(true);
  });

  it("records the measurements that produced the severity", () => {
    const incident = degraded(240).incident!;
    expect(incident.openingSignals.service).toBe("checkout-service");
    expect(incident.openingSignals.errorRate).toBeGreaterThan(0);
    expect(incident.openingSignals.p99).toBeGreaterThan(0);
  });

  it("names the symptom without naming the cause", () => {
    const incident = degraded(240).incident!;
    const text = `${incident.title} ${incident.timeline.map((e) => e.message).join(" ")}`;

    // FR-2.5: the record describes what was measured. Diagnosis is the agent's work,
    // and a title that gave the mechanism away would make the investigation theatre.
    for (const giveaway of ["pool", "connection", "DB_POOL_MAX", "deployment v2.4.1", "rollback"]) {
      expect(text.toLowerCase()).not.toContain(giveaway.toLowerCase());
    }
    expect(incident.title).toContain("checkout-service");
  });

  it("opens exactly one incident, however long the degradation runs", () => {
    const engine = degraded(400);
    expect(engine.world.counters["inc"]).toBe(1);
  });
});

describe("incident lifecycle", () => {
  it("moves through the FR-5.4 statuses, recording the actor each time", () => {
    const engine = degraded(180);

    expect(engine.setIncidentStatus("investigating", "agent")).toEqual({ ok: true });
    expect(engine.setIncidentStatus("identified", "agent")).toEqual({ ok: true });
    expect(engine.setIncidentStatus("mitigating", "human")).toEqual({ ok: true });
    expect(engine.incident!.status).toBe("mitigating");

    const actors = engine.incident!.timeline.map((e) => e.actor);
    expect(actors).toContain("system");
    expect(actors).toContain("agent");
    expect(actors).toContain("human");
  });

  it("allows a move back to investigating after a failed mitigation", () => {
    const engine = degraded(180);
    engine.setIncidentStatus("mitigating", "agent");

    // Spec scenario S5: the fix did not work, so the incident genuinely regresses.
    expect(engine.setIncidentStatus("investigating", "agent")).toEqual({ ok: true });
  });

  it("refuses a no-op status change", () => {
    const engine = degraded(180);
    const result = engine.setIncidentStatus("detected", "human");
    expect(result.ok).toBe(false);
  });

  it("refuses resolution until verification passes — FR-10.4", () => {
    const engine = degraded(180);
    const result = engine.setIncidentStatus("resolved", "agent");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/verification has not passed/);
    expect(engine.incident!.status).not.toBe("resolved");
  });

  it("allows resolution once the correct fix has actually recovered the signals", () => {
    const engine = degraded(180);
    engine.setIncidentStatus("mitigating", "human");
    engine.rollback("checkout-service", "human");
    engine.advanceSeconds(240);

    expect(engine.incident!.recoveryVerifiedAt).not.toBeNull();
    expect(engine.setIncidentStatus("resolved", "human")).toEqual({ ok: true });
    expect(engine.incident!.resolvedAt).toBeGreaterThan(engine.incident!.openedAt);
  });

  it("does not verify recovery before the sustain window has elapsed", () => {
    const engine = degraded(180);
    engine.rollback("checkout-service", "human");
    // The rollout ramps over 45s; even after it, recovery must hold for 30s more.
    engine.advanceSeconds(20);
    expect(engine.incident!.recoveryVerifiedAt).toBeNull();
  });

  it("keeps the resolved incident closed", () => {
    const engine = degraded(180);
    engine.rollback("checkout-service", "human");
    engine.advanceSeconds(240);
    engine.setIncidentStatus("resolved", "human");

    const reopened = engine.setIncidentStatus("investigating", "agent");
    expect(reopened.ok).toBe(false);
  });

  it("puts the remediation on the timeline with its actor — FR-5.5", () => {
    const engine = degraded(180);
    engine.rollback("checkout-service", "human");

    const entry = engine.incident!.timeline.find((e) => e.message.includes("Rolled back"));
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("human");
  });

  it("keeps the timeline in chronological order", () => {
    const engine = degraded(180);
    engine.setIncidentStatus("investigating", "agent");
    engine.advanceSeconds(30);
    engine.rollback("checkout-service", "human");
    engine.advanceSeconds(240);

    const times = engine.incident!.timeline.map((e) => e.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("recovery shape — FR-9.1", () => {
  /**
   * Added after a live browser run, not from reasoning.
   *
   * The original recovery test asserted only that things were healthy 180 seconds
   * after a rollback, which any implementation passes — including one where recovery
   * is instantaneous. FR-9.1 says no action produces instant recovery, so the test has
   * to assert the *shape* of the curve, not its endpoint.
   */
  function recoveryCurve(seed: number): { peakP99: number; secondsToHealthy: number; samples: number[] } {
    const engine = degraded(120, seed);
    const peakP99 = engine.health("checkout-service")!.p99;

    engine.rollback("checkout-service", "human");

    const samples: number[] = [];
    let secondsToHealthy = -1;

    for (let elapsed = 1; elapsed <= 60; elapsed += 1) {
      engine.advanceSeconds(1);
      const point = engine.health("checkout-service")!;
      samples.push(point.p99);
      if (
        secondsToHealthy < 0 &&
        point.p99 <= RECOVERY_P99_MS &&
        point.errorRate <= RECOVERY_ERROR_RATE
      ) {
        secondsToHealthy = elapsed;
      }
    }

    return { peakP99, secondsToHealthy, samples };
  }

  it("does not snap from broken to healthy in a single second", () => {
    const { secondsToHealthy } = recoveryCurve(42);

    // The rollback is a rolling restart: capacity returns progressively, so there is
    // always at least one second of the world being neither broken nor well.
    expect(secondsToHealthy).toBeGreaterThan(1);
  });

  it("passes through a measurable intermediate state", () => {
    const { peakP99, samples } = recoveryCurve(42);

    const between = samples.filter((p99) => p99 > RECOVERY_P99_MS && p99 < peakP99 * 0.9);
    expect(between.length).toBeGreaterThan(0);
  });

  it("recovers on the same trajectory whatever the seed", () => {
    // Guards against a recovery that only looks gradual because of one lucky seed.
    for (const seed of [1, 42, 7, 20260904]) {
      const { secondsToHealthy } = recoveryCurve(seed);
      expect(secondsToHealthy).toBeGreaterThan(1);
      expect(secondsToHealthy).toBeLessThan(60);
    }
  });
});

describe("incident determinism", () => {
  it("produces an identical record for the same seed and action sequence — AC-12", () => {
    const run = () => {
      const engine = degraded(180, 7);
      engine.setIncidentStatus("investigating", "agent");
      engine.rollback("checkout-service", "human");
      engine.advanceSeconds(RECOVERY_SUSTAIN_SEC * 8);
      const incident = engine.incident!;
      return JSON.stringify({
        id: incident.id,
        openedAt: incident.openedAt,
        severity: incident.severity,
        affected: incident.affectedServices,
        verifiedAt: incident.recoveryVerifiedAt,
        timeline: incident.timeline,
      });
    };

    expect(run()).toEqual(run());
  });
});
