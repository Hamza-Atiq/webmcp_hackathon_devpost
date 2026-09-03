import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Engine, type ServiceName } from "../engine";
import { TICK_MS, type SpeedMultiplier } from "../engine/constants";
import type { AuditEntry } from "../mcp/audit";
import type { Proposal } from "../mcp/proposals";
import { ACTION_KINDS, type ActionKind, type RemediationParams } from "../engine";
import {
  cancelOpenProposals,
  notifySession,
  onSessionChange,
  resetSession,
  session,
} from "../session";

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

/** Ceiling on ticks per step, so a long-hidden tab does not death-spiral on return. */
const MAX_TICKS_PER_STEP = 300;

/**
 * How often the driver runs. Also the repaint rate — 60x must not mean 240 renders.
 *
 * A timer rather than `requestAnimationFrame`, and this is not a stylistic choice.
 * Chrome throttles rAF in a hidden tab to *nothing*: the simulated clock stops dead and
 * every tool returns the same frozen numbers. That was invisible to the tests and to any
 * check made with the page in front of you, and it was found by driving the tools from
 * an automated browser tab, where `document.hidden` is true.
 *
 * It matters because an agent may well be operating a page nobody is looking at — which
 * is precisely the ChatGPT in-app browser case this has to work in. A hidden tab throttles
 * timers to about one call a second, so the environment keeps running and simply advances
 * in larger batches. That is exactly what the driver is allowed to vary (FR-3.4): batch
 * size changes the rate, never the values, and the engine checks the scenario schedule
 * after every tick rather than after a batch.
 */
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
  /** FR-12.1 — every action the agent has, a human has too, with the same parameters. */
  remediate(kind: ActionKind, service: ServiceName, params?: RemediationParams): void;
  setStatus(status: "investigating" | "identified" | "mitigating" | "resolved"): void;
  audit: readonly AuditEntry[];
  proposals: readonly Proposal[];
  awaitingApproval: Proposal | undefined;
  approve(id: string): void;
  deny(id: string, reason: string): void;
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
    (operation: string, args: string, summary: string, ok: boolean, sideEffect: "A" | "B" | "C") => {
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
    let previous = performance.now();
    let carry = 0;

    const step = () => {
      const { engine } = session();
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;

      const simMs = elapsed * speedRef.current + carry;
      const ticks = Math.min(MAX_TICKS_PER_STEP, Math.floor(simMs / TICK_MS));
      carry = simMs - ticks * TICK_MS;

      if (ticks > 0) {
        engine.advanceTicks(ticks);
        repaint();
      }
    };

    const timer = setInterval(step, RENDER_INTERVAL_MS);
    return () => clearInterval(timer);
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
    // FR-8.0 — the world an open proposal was reasoning about no longer exists.
    cancelOpenProposals("the scenario was switched");
    record("start_scenario", "scenario: s1", "Scenario started immediately", true, "C");
    repaint();
  }, [record]);

  /**
   * A human action needs no approval — the person clicking is the approver (FR-12.5) —
   * and it runs the same engine operation an approved agent proposal runs (FR-12.2). It
   * mints an action_id and a before-snapshot like any other applied action (FR-10.1a).
   */
  const remediate = useCallback(
    (kind: ActionKind, service: ServiceName, params: RemediationParams = {}) => {
      const { engine } = session();
      const outcome = engine.remediate(kind, service, params, "human");
      record(
        kind,
        `service: ${service}${describeParams(params)}`,
        outcome.ok ? `${outcome.action.summary} (${outcome.action.id})` : outcome.error,
        outcome.ok,
        "C",
      );
      repaint();
    },
    [record],
  );

  const rollback = useCallback(
    (service: ServiceName) => remediate("rollback_deployment", service),
    [remediate],
  );

  const approve = useCallback(
    (id: string) => {
      const { engine, proposals } = session();
      const proposal = proposals.get(id);
      if (!proposals.approve(id, engine.world.nowMs)) return;

      /*
       * Class C: the approval is what causes the change, even though the agent's call is
       * what applies it a moment later. The trail should show the human as the cause.
       */
      record(
        "approve_proposal",
        `proposal: ${id}`,
        `Approved ${proposal?.action ?? "action"} on ${proposal?.service ?? ""}`,
        true,
        "C",
      );
      repaint();
    },
    [record],
  );

  const deny = useCallback(
    (id: string, reason: string) => {
      const { engine, proposals } = session();
      if (!proposals.deny(id, reason, engine.world.nowMs)) return;

      // Class B: the record changed, the environment did not.
      record("deny_proposal", `proposal: ${id}`, `Denied: ${reason}`, true, "B");
      repaint();
    },
    [record],
  );

  const setStatus = useCallback(
    (status: "investigating" | "identified" | "mitigating" | "resolved") => {
      const { engine } = session();
      const result = engine.setIncidentStatus(status, "human");

      /*
       * FR-8.0 — resolving cancels what is open. Ordered after the status change and
       * before the record, so the trail reads the way it happened: the incident closed,
       * and the proposals about it fell with it.
       */
      if (result.ok && status === "resolved") {
        cancelOpenProposals("the incident was resolved");
      }

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
    remediate,
    setStatus,
    audit: current.audit.all,
    proposals: current.proposals.all,
    awaitingApproval: current.proposals.awaitingApproval,
    approve,
    deny,
  };
}

function describeParams(params: RemediationParams): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return parts.length > 0 ? `, ${parts.join(", ")}` : "";
}

export { ACTION_KINDS };
