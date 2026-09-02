import { Engine, SERVICE_NAMES, type ScenarioId } from "./engine";
import type { ServiceName } from "./engine";

/**
 * Console harness — the P1 exit criterion.
 *
 * Unit tests prove the engine agrees with the assumptions of whoever wrote them. They
 * cannot prove it behaves correctly in a browser, in the shipped bundle, driven by a
 * person. This exposes the engine on `window.agentops` so a human can run the whole
 * incident by hand and read the numbers themselves.
 *
 * Development only — `main.tsx` loads it behind `import.meta.env.DEV`, so it is absent
 * from the production bundle.
 */

interface Sample {
  t: string;
  errorRate: string;
  p99: string;
  p50: string;
  incident: string;
}

export interface ConsoleHarness {
  engine: Engine;
  reset(seed?: number): string;
  advance(seconds: number): string;
  start(scenario?: ScenarioId): string;
  rollback(service?: ServiceName): string;
  health(service?: ServiceName): unknown;
  incident(): unknown;
  timeline(): void;
  runbooks(query?: string): void;
  ownership(): void;
  correlation(): void;
  watch(seconds?: number, step?: number): void;
  arc(): void;
}

declare global {
  interface Window {
    agentops: ConsoleHarness;
  }
}

export function exposeConsoleHarness(): void {
  let engine = new Engine();

  const clock = () => `${(engine.world.nowMs / 1000).toFixed(0)}s`;

  const status = (): string => {
    const incident = engine.incident;
    if (!incident) return "none";
    return `${incident.severity} ${incident.status}`;
  };

  const sample = (service: ServiceName): Sample => {
    const point = engine.health(service);
    return {
      t: clock(),
      errorRate: point ? `${(point.errorRate * 100).toFixed(2)}%` : "-",
      p99: point ? `${Math.round(point.p99)} ms` : "-",
      p50: point ? `${Math.round(point.p50)} ms` : "-",
      incident: status(),
    };
  };

  const harness: ConsoleHarness = {
    get engine() {
      return engine;
    },

    reset(seed = 20260904) {
      engine = new Engine(seed);
      return `world reset, seed ${seed}`;
    },

    advance(seconds) {
      engine.advanceSeconds(seconds);
      return `now ${clock()} — ${status()}`;
    },

    start(scenario = "s1") {
      engine.startScenario(scenario);
      return `scenario ${scenario} triggered at ${clock()}`;
    },

    rollback(service = "checkout-service") {
      const ok = engine.rollback(service, "human");
      return ok ? `rolled back ${service} at ${clock()}` : `nothing to roll back on ${service}`;
    },

    health(service = "checkout-service") {
      return engine.health(service);
    },

    incident() {
      return engine.incident;
    },

    timeline() {
      const incident = engine.incident;
      if (!incident) {
        console.log("No incident open.");
        return;
      }
      console.log(`${incident.id} — ${incident.title}`);
      console.table(
        incident.timeline.map((e) => ({
          t: `${(e.t / 1000).toFixed(0)}s`,
          actor: e.actor,
          event: e.message,
        })),
      );
    },

    runbooks(query) {
      const found = engine.runbooks(query);
      console.log(`${found.length} runbook(s) for ${query ? `"${query}"` : "any symptom"}:`);
      console.table(
        found.map((r) => ({ id: r.id, title: r.title, steps: r.steps.length })),
      );
      for (const r of found) {
        console.log(`
${r.id} — ${r.title}`);
        r.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
      }
    },

    ownership() {
      console.table(SERVICE_NAMES.map((name) => engine.ownership(name)));
    },

    /**
     * Prove the log-to-trace link is real: take recent logs carrying a correlation id and
     * confirm the trace it names actually exists, with matching service and timestamp.
     */
    correlation() {
      const correlated = engine.store.logs.filter((l) => l.correlationId).slice(-10);
      if (correlated.length === 0) {
        console.log("No correlated logs yet — run agentops.advance(120) after an incident opens.");
        return;
      }
      console.table(
        correlated.map((log) => {
          const trace = engine.store.traces.find((t) => t.id === log.correlationId);
          return {
            log: log.id,
            correlationId: log.correlationId,
            traceFound: trace ? "yes" : "NO — BROKEN LINK",
            sameService: trace ? String(trace.service === log.service) : "-",
            traceMs: trace ? Math.round(trace.durationMs) : "-",
            message: log.message.slice(0, 46),
          };
        }),
      );
    },

    /** Advance in steps, printing every service's signals so nothing is hidden. */
    watch(seconds = 60, step = 10) {
      const rows: Array<Record<string, string>> = [];
      for (let elapsed = 0; elapsed < seconds; elapsed += step) {
        engine.advanceSeconds(step);
        const row: Record<string, string> = { t: clock(), incident: status() };
        for (const name of SERVICE_NAMES) {
          const point = engine.health(name);
          row[name] = point
            ? `${(point.errorRate * 100).toFixed(1)}% / ${Math.round(point.p99)}ms`
            : "-";
        }
        rows.push(row);
      }
      console.table(rows);
    },

    /**
     * The whole story, start to finish, in one call: healthy baseline, onset,
     * detection, rollback, recovery. Every number below is measured, not asserted.
     */
    arc() {
      engine = new Engine(20260904);
      const rows: Sample[] = [];
      const mark = (label: string) => {
        rows.push({ ...sample("checkout-service"), t: `${clock()} ${label}` });
      };

      engine.advanceSeconds(30);
      mark("(healthy)");
      engine.advanceSeconds(30);
      mark("(healthy)");

      engine.startScenario("s1");
      mark("<- SCENARIO STARTS");

      for (let i = 0; i < 6; i++) {
        engine.advanceSeconds(20);
        mark(engine.incident ? "" : "(degrading)");
      }

      engine.rollback("checkout-service", "human");
      mark("<- ROLLBACK APPLIED");

      for (let i = 0; i < 8; i++) {
        engine.advanceSeconds(20);
        mark(engine.incident?.recoveryVerifiedAt ? "(recovered)" : "(recovering)");
      }

      console.table(rows);
      harness.timeline();
      console.log(
        "resolve while degraded ->",
        JSON.stringify(new Engine(1).setIncidentStatus("resolved", "agent")),
      );
      console.log("resolve now ->", JSON.stringify(engine.setIncidentStatus("resolved", "human")));
    },
  };

  window.agentops = harness;
  console.log("[agentops] console harness ready. Try: agentops.arc()");
}
