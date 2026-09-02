import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Engine, type ServiceName } from "../engine";
import { HEALTHY_WINDOW_MS, TICK_MS, type SpeedMultiplier } from "../engine/constants";

/**
 * The driver that turns real time into simulated time.
 *
 * Wall-clock time is legitimate here and nowhere in the engine (FR-3.1). This module
 * decides *how many* fixed-size ticks to run; it never decides how large a tick is, so
 * a run at 60x produces exactly the evidence a run at 1x produces (FR-3.4, FR-3.4a).
 */

/** Ceiling on ticks per frame, so a backgrounded tab does not death-spiral on return. */
const MAX_TICKS_PER_FRAME = 300;

/** The UI repaints at this rate regardless of tick rate — 60x must not mean 240 renders. */
const RENDER_INTERVAL_MS = 90;

export interface AuditEntry {
  id: number;
  simMs: number;
  /** FR-13.1a: a dashboard click is a ui_action, never a tool invocation. */
  kind: "ui_action";
  source: "ui";
  actor: "human";
  operation: string;
  detail: string;
  result: string;
  ok: boolean;
}

export interface Simulation {
  engine: Engine;
  /** Bumped on every repaint so components re-read the mutable engine. */
  version: number;
  speed: SpeedMultiplier;
  setSpeed(speed: SpeedMultiplier): void;
  reset(): void;
  rollback(service: ServiceName): void;
  setStatus(status: "investigating" | "identified" | "mitigating" | "resolved"): void;
  audit: AuditEntry[];
}

export function useSimulation(): Simulation {
  const engineRef = useRef<Engine | null>(null);
  if (engineRef.current === null) engineRef.current = new Engine();

  const [speed, setSpeed] = useState<SpeedMultiplier>(10);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [version, repaint] = useReducer((n: number) => n + 1, 0);

  const speedRef = useRef(speed);
  speedRef.current = speed;

  const scenarioStarted = useRef(false);
  const auditId = useRef(0);

  const record = useCallback(
    (operation: string, detail: string, result: string, ok: boolean) => {
      const engine = engineRef.current!;
      auditId.current += 1;
      setAudit((entries) => [
        ...entries,
        {
          id: auditId.current,
          simMs: engine.world.nowMs,
          kind: "ui_action",
          source: "ui",
          actor: "human",
          operation,
          detail,
          result,
          ok,
        },
      ]);
    },
    [],
  );

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let lastRender = 0;
    let carry = 0;

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);

      const engine = engineRef.current!;
      const elapsed = now - previous;
      previous = now;

      const simMs = elapsed * speedRef.current + carry;
      const ticks = Math.min(MAX_TICKS_PER_FRAME, Math.floor(simMs / TICK_MS));
      carry = simMs - ticks * TICK_MS;

      if (ticks > 0) {
        engine.advanceTicks(ticks);

        // FR-5.1: the environment is healthy for a fixed opening window, then the
        // scenario begins on its own. Keyed to simulated time rather than wall-clock,
        // so the onset lands on the same tick at every speed.
        if (!scenarioStarted.current && engine.world.nowMs >= HEALTHY_WINDOW_MS) {
          scenarioStarted.current = true;
          engine.startScenario("s1");
        }
      }

      if (now - lastRender >= RENDER_INTERVAL_MS) {
        lastRender = now;
        repaint();
      }
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const reset = useCallback(() => {
    engineRef.current = new Engine();
    scenarioStarted.current = false;
    auditId.current = 0;
    setAudit([]);
    repaint();
  }, []);

  const rollback = useCallback(
    (service: ServiceName) => {
      const engine = engineRef.current!;
      const deployment = engine.world.deployments
        .filter((d) => d.service === service && !d.rolledBack)
        .sort((a, b) => b.t - a.t)[0];

      const ok = engine.rollback(service, "human");
      record(
        "rollback_deployment",
        `service: ${service}`,
        ok
          ? `Rolled back ${deployment?.version ?? "latest"} → ${deployment?.previousVersion ?? "previous"}`
          : `No deployment available to roll back on ${service}`,
        ok,
      );
      repaint();
    },
    [record],
  );

  const setStatus = useCallback(
    (status: "investigating" | "identified" | "mitigating" | "resolved") => {
      const engine = engineRef.current!;
      const result = engine.setIncidentStatus(status, "human");
      record(
        "update_incident_status",
        `status: ${status}`,
        result.ok ? `Incident is now ${status}` : result.error,
        result.ok,
      );
      repaint();
    },
    [record],
  );

  return {
    engine: engineRef.current,
    version,
    speed,
    setSpeed,
    reset,
    rollback,
    setStatus,
    audit,
  };
}
