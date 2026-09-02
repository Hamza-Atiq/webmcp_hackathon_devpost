import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Engine, type ServiceName } from "../engine";
import { TICK_MS, type SpeedMultiplier } from "../engine/constants";
import type { AuditEntry } from "../mcp/audit";
import { notifySession, onSessionChange, resetSession, session } from "../session";

/**
 * The driver that turns real time into simulated time.
 *
 * Wall-clock time is legitimate here and nowhere in the engine (FR-3.1). This module
 * decides *how many* fixed-size ticks to run; it never decides how large a tick is, so
 * a run at 60x produces exactly the evidence a run at 1x produces (FR-3.4, FR-3.4a).
 *
 * The engine itself is owned by `session`, not by this hook. Tools are registered before
 * the first render and resolve the engine at call time, so a reset swaps the world for
 * the interface and the agent together — a hook-owned engine would leave tool handlers
 * reading a world the human can no longer see.
 */

/** Ceiling on ticks per frame, so a backgrounded tab does not death-spiral on return. */
const MAX_TICKS_PER_FRAME = 300;

/** The UI repaints at this rate regardless of tick rate — 60x must not mean 240 renders. */
const RENDER_INTERVAL_MS = 90;

export type { AuditEntry };

export interface Simulation {
  engine: Engine;
  /** Bumped on every repaint so components re-read the mutable engine. */
  version: number;
  speed: SpeedMultiplier;
  setSpeed(speed: SpeedMultiplier): void;
  reset(): void;
  /** FR-5.2 — begin the scenario immediately instead of waiting out the healthy window. */
  triggerScenario(): void;
  scenarioPending: boolean;
  rollback(service: ServiceName): void;
  setStatus(status: "investigating" | "identified" | "mitigating" | "resolved"): void;
  audit: readonly AuditEntry[];
}

export function useSimulation(): Simulation {
  const [speed, setSpeed] = useState<SpeedMultiplier>(10);
  const [version, repaint] = useReducer((n: number) => n + 1, 0);

  const speedRef = useRef(speed);
  speedRef.current = speed;

  /*
   * Tool calls arrive from outside React and mutate the same trail the interface renders,
   * so the log is read through an external store rather than component state. Without
   * this the activity log would sit empty while an agent worked.
   */
  const current = useSyncExternalStore(onSessionChange, session, session);

  useEffect(() => onSessionChange(repaint), []);

  /** FR-13.1a — a dashboard click is a `ui_action`, never a tool call. */
  const record = useCallback(
    (operation: string, args: string, summary: string, ok: boolean, sideEffect: "A" | "C") => {
      const { engine, audit } = session();
      audit.add({
        timestamp: engine.world.nowMs,
        kind: "ui_action",
        operation,
        source: "ui",
        actor: "human",
        arguments: args,
        result_summary: summary,
        duration_ms: 0,
        status: ok ? "ok" : "refused",
        side_effect_class: sideEffect,
      });
      notifySession();
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

      const { engine } = session();
      const elapsed = now - previous;
      previous = now;

      const simMs = elapsed * speedRef.current + carry;
      const ticks = Math.min(MAX_TICKS_PER_FRAME, Math.floor(simMs / TICK_MS));
      carry = simMs - ticks * TICK_MS;

      if (ticks > 0) engine.advanceTicks(ticks);

      if (now - lastRender >= RENDER_INTERVAL_MS) {
        lastRender = now;
        repaint();
      }
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const reset = useCallback(() => {
    // FR-15.3 — a new world, a new evidence registry and an empty trail. Nothing carries.
    resetSession();
    repaint();
  }, []);

  const triggerScenario = useCallback(() => {
    const { engine } = session();
    if (!engine.scenarioPending) return;
    engine.startScenario("s1");
    record("start_scenario", "scenario: s1", "Scenario started immediately", true, "C");
    repaint();
  }, [record]);

  const rollback = useCallback(
    (service: ServiceName) => {
      const { engine } = session();

      /*
       * A human rollback is an applied action like any other: it mints an action_id and
       * stores its before-snapshot, so `verify_remediation` can measure against it even
       * though no agent was involved (FR-10.1a).
       */
      const applied = engine.rollback(service, "human");
      record(
        "rollback_deployment",
        `service: ${service}`,
        applied ? `${applied.summary} (${applied.id})` : `No deployment available to roll back on ${service}`,
        applied !== null,
        "C",
      );
      repaint();
    },
    [record],
  );

  const setStatus = useCallback(
    (status: "investigating" | "identified" | "mitigating" | "resolved") => {
      const { engine } = session();
      const result = engine.setIncidentStatus(status, "human");
      record(
        "update_incident_status",
        `status: ${status}`,
        result.ok ? `Incident is now ${status}` : result.error,
        result.ok,
        "C",
      );
      repaint();
    },
    [record],
  );

  return {
    engine: current.engine,
    version,
    speed,
    setSpeed,
    reset,
    triggerScenario,
    scenarioPending: current.engine.scenarioPending,
    rollback,
    setStatus,
    audit: current.audit.all,
  };
}
