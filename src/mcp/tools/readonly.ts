import type { Engine } from "../../engine";
import { SERVICE_NAMES } from "../../engine/world";
import { isRecovered } from "../../engine/incident";
import { meanOver, metricsInWindow } from "../../engine/store";
import {
  RECOVERY_ERROR_RATE,
  RECOVERY_P99_MS,
  RECOVERY_SUSTAIN_SEC,
  INCIDENT_ERROR_RATE_THRESHOLD,
  INCIDENT_P99_THRESHOLD_MS,
  METRIC_RETENTION_SEC,
} from "../../engine/constants";
import type { Deployment, LogEntry, MetricField, Runbook, ServiceName, Span, Trace } from "../../engine";
import { bounded } from "../bounded";
import { clampLimit, missingParam, ok, refuse, unknownValue, type ToolResult } from "../contracts";
import { mintSeriesId } from "../evidence";

/**
 * The twelve Class A tools — spec 003 §9.
 *
 * Every one is a plain function of `(engine, args)`. `register.ts` binds them and adds
 * nothing: that split is what lets the same code be checked headlessly in tests, by hand
 * from the browser console on a browser with no WebMCP at all, and through the real API
 * in the DevTools panel — so a passing console check and a passing panel check cannot
 * disagree about behaviour, only about registration.
 *
 * Tool *descriptions* live in `schemas.ts`, beside the input schemas an agent reads them
 * with. What lives here is only what the tool does.
 *
 * **No tool discloses the scenario** (FR-2.5). Nothing below names a mechanism, a cause,
 * or a correct action. The failure test stands: if an agent can name the root cause from
 * a single call, this layer is wrong.
 */

export type Args = Record<string, unknown>;

/** Simulated seconds, the unit every timestamp is reported in — compact and readable. */
function sec(ms: number): number {
  return Math.round(ms / 1000);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function resolveService(value: unknown): ServiceName | null {
  return SERVICE_NAMES.includes(value as ServiceName) ? (value as ServiceName) : null;
}

/**
 * Windows are relative to now, in simulated seconds (spec 003 §7).
 *
 * An agent has no reliable view of the simulated clock's origin, and "the last two
 * minutes" is what an on-call engineer actually asks for. A window that runs backwards
 * is the one case FR-14.5 asks to be refused rather than clamped, because there is no
 * sensible interpretation of it to fall back on.
 */
function resolveWindow(
  engine: Engine,
  value: unknown,
  fallbackSec: number,
): { fromMs: number; toMs: number; seconds: number; note: string | null } | ToolResult {
  const toMs = engine.world.nowMs;
  if (value === undefined || value === null) {
    return { fromMs: toMs - fallbackSec * 1000, toMs, seconds: fallbackSec, note: null };
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return refuse(
      `window_seconds must be a positive number of simulated seconds looking backwards from now; ` +
        `got ${JSON.stringify(value)}. Example: window_seconds: 120 for the last two minutes.`,
    );
  }

  const seconds = Math.min(Math.floor(n), METRIC_RETENTION_SEC);
  const note =
    seconds < Math.floor(n)
      ? `window_seconds was clamped from ${Math.floor(n)} to ${METRIC_RETENTION_SEC}, the retention limit.`
      : null;
  return { fromMs: toMs - seconds * 1000, toMs, seconds, note };
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

// ---------------------------------------------------------------------------
// 1 — list_services
// ---------------------------------------------------------------------------

export function listServices(engine: Engine): ToolResult {
  const records = SERVICE_NAMES.map((name) => {
    const point = engine.health(name);
    const state = engine.world.services[name];
    return {
      id: `svc_${name}`,
      name,
      depends_on: state.dependencies,
      replicas: Math.round(state.config.replicas),
      /*
       * Read off the same thresholds the dashboard uses, never off the scenario. An
       * inventory that labelled the culprit would be an oracle (FR-2.5).
       */
      status: point
        ? point.errorRate > INCIDENT_ERROR_RATE_THRESHOLD || point.p99 > INCIDENT_P99_THRESHOLD_MS
          ? "degraded"
          : "healthy"
        : "starting",
    };
  });

  return bounded({
    records,
    cap: records.length,
    narrowBy: "There are only five services; this list is never long.",
    data: (rows) => ({ services: rows }),
    ids: (rows) => rows.map((r) => r.id),
  });
}

// ---------------------------------------------------------------------------
// 2 — get_service_health
// ---------------------------------------------------------------------------

/** Signals are reported as a short mean, for the reason severity classification smooths. */
const HEALTH_WINDOW_SEC = 5;

export function getServiceHealth(engine: Engine, args: Args): ToolResult {
  const service = resolveService(args.service);
  if (!service) {
    if (args.service === undefined) {
      return missingParam("service", 'get_service_health({ service: "checkout-service" })');
    }
    return unknownValue("service", args.service, SERVICE_NAMES);
  }

  const point = engine.health(service);
  if (!point) {
    return refuse(
      `No metrics for ${service} yet — the environment has not completed its first second. Retry shortly.`,
    );
  }

  const mean = (field: MetricField) => meanOver(engine.store, service, field, HEALTH_WINDOW_SEC) ?? 0;
  const seriesId = mintSeriesId(engine.world);

  return ok(
    {
      series_id: seriesId,
      service,
      at_s: sec(point.t),
      window_s: HEALTH_WINDOW_SEC,
      latency_ms: {
        p50: Math.round(mean("p50")),
        p95: Math.round(mean("p95")),
        p99: Math.round(mean("p99")),
      },
      traffic_rps: Math.round(mean("requests")),
      error_rate: round(mean("errorRate"), 4),
      saturation: {
        cpu: round(mean("cpu"), 2),
        memory: round(mean("memory"), 2),
        replicas: point.replicas,
      },
    },
    [seriesId],
  );
}

// ---------------------------------------------------------------------------
// 3 — get_metrics
// ---------------------------------------------------------------------------

const METRIC_FIELDS: MetricField[] = [
  "errorRate",
  "p50",
  "p95",
  "p99",
  "cpu",
  "memory",
  "requests",
  "errors",
  "replicas",
];

/** FR-0 caps a series at 60 points, so a long window is downsampled rather than refused. */
const MAX_SERIES_POINTS = 60;

export function getMetrics(engine: Engine, args: Args): ToolResult {
  const service = resolveService(args.service);
  if (!service) {
    if (args.service === undefined) {
      return missingParam(
        "service",
        'get_metrics({ service: "checkout-service", metric: "p99", window_seconds: 300 })',
      );
    }
    return unknownValue("service", args.service, SERVICE_NAMES);
  }

  const metric = args.metric as MetricField;
  if (!METRIC_FIELDS.includes(metric)) {
    if (args.metric === undefined) return missingParam("metric", 'metric: "p99"');
    return unknownValue("metric", args.metric, METRIC_FIELDS);
  }

  const window = resolveWindow(engine, args.window_seconds, 300);
  if (isToolResult(window)) return window;

  const points = metricsInWindow(engine.store, service, window.fromMs, window.toMs);
  if (points.length === 0) {
    return refuse(
      `No ${metric} points for ${service} in the last ${window.seconds}s. The environment has been ` +
        `running for ${sec(engine.world.nowMs)}s; try a shorter window.`,
    );
  }

  /*
   * Downsampling takes every nth point rather than averaging a bucket. An average would
   * smooth away the step change that makes an incident legible, and *when* a signal moved
   * is the entire reason to call this tool.
   */
  const step = Math.max(1, Math.ceil(points.length / MAX_SERIES_POINTS));
  const sampled = points.filter((_, i) => i % step === 0);

  const places = metric === "errorRate" || metric === "cpu" || metric === "memory" ? 3 : 0;
  const seriesId = mintSeriesId(engine.world);

  return ok(
    {
      series_id: seriesId,
      service,
      metric,
      window_s: window.seconds,
      interval_s: step,
      /** [simulated second, value] pairs, oldest first. */
      points: sampled.map((p) => [sec(p.t), round(p[metric], places)]),
    },
    [seriesId],
  );
}

// ---------------------------------------------------------------------------
// 4 — search_logs
// ---------------------------------------------------------------------------

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

interface LogRow {
  id: string;
  t: number;
  service: ServiceName;
  level: string;
  message: string;
  correlation_id?: string;
  trace_available?: boolean;
}

export function searchLogs(engine: Engine, args: Args): ToolResult {
  if (args.service !== undefined && !resolveService(args.service)) {
    return unknownValue("service", args.service, SERVICE_NAMES);
  }
  if (args.level !== undefined && !LOG_LEVELS.includes(args.level as (typeof LOG_LEVELS)[number])) {
    return unknownValue("level", args.level, LOG_LEVELS);
  }

  const window = resolveWindow(engine, args.window_seconds, 300);
  if (isToolResult(window)) return window;

  const contains = typeof args.contains === "string" ? args.contains.toLowerCase() : null;
  const limit = clampLimit(args.limit, 20, 50);

  const live = new Set(engine.store.traces.map((t) => t.id));

  const matches = engine.store.logs
    .filter((entry) => entry.t >= window.fromMs && entry.t <= window.toMs)
    .filter((entry) => args.service === undefined || entry.service === args.service)
    .filter((entry) => args.level === undefined || entry.level === args.level)
    .filter((entry) => contains === null || entry.message.toLowerCase().includes(contains))
    .reverse(); // Most recent first: an investigation starts from now and works backwards.

  if (matches.length === 0) {
    return refuse(
      `No log entries matched in the last ${window.seconds}s. Widen window_seconds, drop the ` +
        `contains filter, or try level:"error".`,
    );
  }

  const rows: LogRow[] = matches.map((entry: LogEntry) => ({
    id: entry.id,
    t: sec(entry.t),
    service: entry.service,
    level: entry.level,
    message: entry.message,
    ...(entry.correlationId
      ? {
          correlation_id: entry.correlationId,
          /*
           * Traces evict far faster than logs (spec 003 §5a), so a correlation id is not
           * a promise. Saying which links still resolve lets an agent spend its calls on
           * the ones worth opening rather than discovering the limit one refusal at a time.
           */
          trace_available: live.has(entry.correlationId),
        }
      : {}),
  }));

  return bounded({
    records: rows,
    cap: limit.value,
    narrowBy: 'Narrow with level:"error", a contains filter, a service, or a shorter window_seconds.',
    /*
     * No reducers: the correlation id is not an optional field (spec 003 §6). It is the
     * only link between logs and traces, and FR-4.8 exists to make an agent cross that
     * boundary — so an over-long response gives up whole log lines rather than the link.
     * Four lines that can be followed beat seven that lead nowhere.
     */
    data: (list) => ({ entries: list }),
    ids: (list) => list.map((r) => r.id),
    note: limit.note,
    untrusted: true, // FR-6.2 — log text originates in request data.
  });
}

// ---------------------------------------------------------------------------
// 5 — get_trace
// ---------------------------------------------------------------------------

const MAX_SPANS = 40;

interface SpanRow {
  name: string;
  service: ServiceName;
  start_ms: number;
  duration_ms: number;
  depth: number;
  error?: string;
}

function flattenSpans(root: Span): SpanRow[] {
  const out: SpanRow[] = [];
  const walk = (span: Span, depth: number) => {
    out.push({
      name: span.name,
      service: span.service,
      start_ms: Math.round(span.startMs),
      duration_ms: Math.round(span.durationMs),
      depth,
      ...(span.error ? { error: span.error } : {}),
    });
    for (const child of span.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

export function getTrace(engine: Engine, args: Args): ToolResult {
  const id = args.trace_id;
  if (typeof id !== "string") return missingParam("trace_id", 'get_trace({ trace_id: "trc_0412" })');

  const trace = engine.store.traces.find((t) => t.id === id);
  if (!trace) {
    const minted = engine.world.counters["trc"] ?? 0;
    const requested = Number(id.replace(/^trc_/, ""));
    const everExisted = /^trc_\d+$/.test(id) && requested >= 1 && requested <= minted;

    /*
     * The two failures mean different things and an agent should be able to tell them
     * apart: one says "look somewhere else", the other says "you were too slow". An empty
     * result would say neither (spec 003 §5a).
     */
    return refuse(
      everExisted
        ? `Trace ${id} is no longer retained. Traces cover approximately the last 5 minutes; the ` +
            `log entry that cited it is still available, and list_traces shows what is live now.`
        : `Unknown trace id ${JSON.stringify(id)}. Trace ids look like "trc_0412" and come from ` +
            `list_traces or from a log entry's correlation_id.`,
    );
  }

  const spans = flattenSpans(trace.root);

  return bounded({
    records: spans,
    cap: MAX_SPANS,
    narrowBy: "The span tree exceeded the cap; the root and its nearest children are shown.",
    // Spec 003 §6 drops span children beyond depth 2 before anything else.
    reducers: [(span) => span],
    data: (list) => ({
      id: trace.id,
      t: sec(trace.t),
      service: trace.service,
      duration_ms: Math.round(trace.durationMs),
      status: trace.status,
      spans: list.filter((s) => s.depth <= 2),
    }),
    ids: () => [trace.id],
  });
}

// ---------------------------------------------------------------------------
// 6 — list_traces
// ---------------------------------------------------------------------------

/** "Slow" is relative to the incident threshold, never to a scenario. */
const SLOW_TRACE_MS = INCIDENT_P99_THRESHOLD_MS;

export function listTraces(engine: Engine, args: Args): ToolResult {
  const service = resolveService(args.service);
  if (!service) {
    if (args.service === undefined) {
      return missingParam("service", 'list_traces({ service: "checkout-service", slow_only: true })');
    }
    return unknownValue("service", args.service, SERVICE_NAMES);
  }

  const window = resolveWindow(engine, args.window_seconds, 300);
  if (isToolResult(window)) return window;

  const limit = clampLimit(args.limit, 10, 25);

  const matches = engine.store.traces
    .filter((t: Trace) => t.service === service && t.t >= window.fromMs && t.t <= window.toMs)
    .filter((t) => args.slow_only !== true || t.durationMs >= SLOW_TRACE_MS)
    .filter((t) => args.errors_only !== true || t.status === "error")
    .sort((a, b) => b.durationMs - a.durationMs); // Slowest first — the ones worth opening.

  if (matches.length === 0) {
    return refuse(
      `No traces for ${service} in the last ${window.seconds}s matching those filters. Traces are ` +
        `sampled and retained for about 5 minutes; try dropping slow_only or errors_only.`,
    );
  }

  const rows = matches.map((t) => ({
    id: t.id,
    t: sec(t.t),
    duration_ms: Math.round(t.durationMs),
    status: t.status,
  }));

  return bounded({
    records: rows,
    cap: limit.value,
    narrowBy: "Pass slow_only, errors_only, or a shorter window_seconds to see fewer traces.",
    data: (list) => ({ service, traces: list }),
    ids: (list) => list.map((r) => r.id),
    note: limit.note,
  });
}

// ---------------------------------------------------------------------------
// 7 — list_recent_deployments
// ---------------------------------------------------------------------------

/** `summary` is optional because bounding drops it first — spec 003 §6. */
interface DeploymentRow {
  id: string;
  t: number;
  service: ServiceName;
  version: string;
  previous_version: string | null;
  author: string;
  rolled_back: boolean;
  summary?: string;
}

export function listRecentDeployments(engine: Engine, args: Args): ToolResult {
  if (args.service !== undefined && !resolveService(args.service)) {
    return unknownValue("service", args.service, SERVICE_NAMES);
  }

  /*
   * The default window is deliberately a full day. Baseline history sits six to fourteen
   * hours before T+0 (FR-2.4a), and an agent asking "what changed" has to be able to see
   * that most services were *not* touched recently — otherwise every service looks equally
   * suspicious and the deployment evidence proves nothing.
   */
  const window = resolveWindow(engine, args.window_seconds, 24 * 3600);
  if (isToolResult(window)) return window;

  const limit = clampLimit(args.limit, 10, 25);

  const matches = engine.world.deployments
    .filter((d: Deployment) => args.service === undefined || d.service === args.service)
    .filter((d) => d.t >= window.fromMs && d.t <= window.toMs)
    .sort((a, b) => b.t - a.t);

  if (matches.length === 0) {
    return refuse(
      `No deployments in the last ${window.seconds}s${args.service ? ` for ${args.service}` : ""}. ` +
        `Widen window_seconds — deployment history reaches back well before the incident.`,
    );
  }

  const rows: DeploymentRow[] = matches.map((d) => ({
    id: d.id,
    t: sec(d.t),
    service: d.service,
    version: d.version,
    previous_version: d.previousVersion,
    author: d.author,
    rolled_back: d.rolledBack,
    summary: d.summary,
  }));

  return bounded({
    records: rows,
    cap: limit.value,
    narrowBy: "Pass a service or a shorter window_seconds; get_deployment_diff shows what one changed.",
    reducers: [
      (row) => {
        const { summary: _summary, ...rest } = row;
        return rest;
      },
    ],
    data: (list) => ({ deployments: list }),
    ids: (list) => list.map((r) => r.id),
    note: limit.note,
  });
}

// ---------------------------------------------------------------------------
// 8 — get_deployment_diff
// ---------------------------------------------------------------------------

export function getDeploymentDiff(engine: Engine, args: Args): ToolResult {
  const id = args.deployment_id;
  if (typeof id !== "string") {
    return missingParam("deployment_id", 'get_deployment_diff({ deployment_id: "dep_0006" })');
  }

  const deployment = engine.world.deployments.find((d) => d.id === id);
  if (!deployment) {
    const known = engine.world.deployments.map((d) => d.id).join(", ");
    return refuse(`Unknown deployment id ${JSON.stringify(id)}. Known deployments: ${known}.`);
  }

  return ok(
    {
      id: deployment.id,
      t: sec(deployment.t),
      service: deployment.service,
      version: deployment.version,
      previous_version: deployment.previousVersion,
      author: deployment.author,
      rolled_back: deployment.rolledBack,
      summary: deployment.summary,
      /** Exactly the settings this deployment altered. */
      changes: deployment.diff,
    },
    [deployment.id],
  );
}

// ---------------------------------------------------------------------------
// 9 — get_runbook
// ---------------------------------------------------------------------------

/** `symptoms` and `signals` are optional: bounding drops them before the steps. */
interface RunbookRow {
  id: string;
  title: string;
  applies_to: string | ServiceName[];
  symptoms?: string[];
  signals?: string[];
  steps: string[];
}

export function getRunbook(engine: Engine, args: Args): ToolResult {
  if (args.service !== undefined && !resolveService(args.service)) {
    return unknownValue("service", args.service, SERVICE_NAMES);
  }
  const symptom = typeof args.symptom === "string" ? args.symptom : undefined;
  const matches = engine.runbooks(symptom, args.service as ServiceName | undefined);

  if (matches.length === 0) {
    const titles = engine
      .runbooks()
      .map((r) => r.title)
      .join("; ");
    return refuse(
      `No runbook matched ${JSON.stringify(symptom ?? "")}. The library covers: ${titles}. Try a ` +
        `symptom in plain words, such as symptom: "latency".`,
    );
  }

  const rows: RunbookRow[] = matches.map((r: Runbook) => ({
    id: r.id,
    title: r.title,
    applies_to: r.appliesTo === "any" ? "any" : r.appliesTo,
    symptoms: r.symptoms,
    signals: r.signals,
    steps: r.steps,
  }));

  /*
   * Three matches at most, and bounding will usually reduce that to one. That is intended
   * rather than a limitation: a broad query returns the single most relevant procedure
   * *complete*, and `total_count` tells the agent neighbours exist and its query was too
   * broad to choose between them. A page of stubs would be worse — the steps are the whole
   * value of a runbook.
   */
  return bounded({
    records: rows,
    cap: 3,
    narrowBy: "Pass a more specific symptom, or a service, to choose between matching runbooks.",
    reducers: [
      (row) => {
        const { signals: _signals, ...rest } = row;
        return rest;
      },
      (row) => {
        const { signals: _signals, symptoms: _symptoms, ...rest } = row;
        return rest;
      },
    ],
    data: (list) => ({ runbooks: list }),
    ids: (list) => list.map((r) => r.id),
  });
}

// ---------------------------------------------------------------------------
// 10 — get_service_ownership
// ---------------------------------------------------------------------------

export function getServiceOwnership(engine: Engine, args: Args): ToolResult {
  const service = resolveService(args.service);
  if (!service) {
    if (args.service === undefined) {
      return missingParam("service", 'get_service_ownership({ service: "checkout-service" })');
    }
    return unknownValue("service", args.service, SERVICE_NAMES);
  }

  const owner = engine.ownership(service);
  return ok(
    {
      id: owner.id,
      service: owner.service,
      team: owner.team,
      on_call: owner.onCall,
      escalation: owner.escalation,
      channel: owner.channel,
      policy: owner.policy,
    },
    [owner.id],
  );
}

// ---------------------------------------------------------------------------
// 11 — get_incident
// ---------------------------------------------------------------------------

const MAX_TIMELINE_ENTRIES = 30;

export function getIncident(engine: Engine): ToolResult {
  const incident = engine.incident;
  if (!incident) {
    return refuse(
      `No incident is open. The environment is still being monitored; get_service_health or ` +
        `get_metrics will show the current state.`,
    );
  }

  const entries = incident.timeline
    .slice(-MAX_TIMELINE_ENTRIES)
    .map((e) => ({ t: sec(e.t), actor: e.actor, message: e.message }));

  return bounded({
    records: entries,
    cap: MAX_TIMELINE_ENTRIES,
    narrowBy: "Only the most recent timeline entries are shown.",
    data: (list) => ({
      id: incident.id,
      opened_at_s: sec(incident.openedAt),
      severity: incident.severity,
      status: incident.status,
      title: incident.title,
      affected_services: incident.affectedServices,
      /** The measurements that produced the opening severity — AC-5a, kept traceable. */
      opening_signals: {
        service: incident.openingSignals.service,
        error_rate: round(incident.openingSignals.errorRate, 4),
        p99_ms: Math.round(incident.openingSignals.p99),
      },
      recovery_verified_at_s:
        incident.recoveryVerifiedAt === null ? null : sec(incident.recoveryVerifiedAt),
      timeline: list,
    }),
    ids: () => [incident.id],
  });
}

// ---------------------------------------------------------------------------
// 12 — verify_remediation
// ---------------------------------------------------------------------------

export function verifyRemediation(engine: Engine, args: Args): ToolResult {
  const requested = args.action_id;
  if (requested !== undefined && typeof requested !== "string") {
    return refuse(
      `action_id must be a string such as "act_0001", or omitted to verify the most recent action.`,
    );
  }

  const action = requested === undefined ? engine.lastAction : engine.action(requested);
  if (!action) {
    if (requested !== undefined) {
      const known = engine.actions.map((a) => a.id).join(", ") || "none yet";
      return refuse(`Unknown action_id ${JSON.stringify(requested)}. Applied actions: ${known}.`);
    }
    return refuse(
      `Nothing has been applied yet, so there is nothing to verify. verify_remediation compares the ` +
        `state captured when an action was applied against the state now.`,
    );
  }

  /*
   * The services judged are the ones the incident affects, falling back to the action's
   * own target when nothing is open. Judging all five would let four healthy services
   * outvote the one that is broken.
   */
  const judged = engine.incident?.affectedServices ?? [action.service];

  const comparisons = judged.map((service) => {
    const before = action.before[service];
    const errorRate = meanOver(engine.store, service, "errorRate", HEALTH_WINDOW_SEC) ?? 0;
    const p99 = meanOver(engine.store, service, "p99", HEALTH_WINDOW_SEC) ?? 0;
    return {
      service,
      error_rate: {
        before: round(before.errorRate, 4),
        now: round(errorRate, 4),
        threshold: RECOVERY_ERROR_RATE,
      },
      p99_ms: { before: Math.round(before.p99), now: Math.round(p99), threshold: RECOVERY_P99_MS },
      within_thresholds: isRecovered({ errorRate, p99, requests: 0, errors: 0 }),
      improved: errorRate < before.errorRate - 1e-9 || p99 < before.p99 - 1,
    };
  });

  const failing = comparisons.filter((c) => !c.within_thresholds);

  /*
   * FR-10.2: the verdict is measured, never inferred from which action was taken. A
   * rollback of an unrelated deployment reaches this code by exactly the path the correct
   * fix takes, and fails for the only reason that counts — the signals did not come back.
   *
   * FR-10.4 gates a pass on the sustain window the engine already tracks, so a one-second
   * dip below the thresholds cannot resolve an incident.
   */
  const incident = engine.incident;
  const sustained = incident !== null && incident.recoveryVerifiedAt !== null;
  const verdict =
    failing.length === 0 && (sustained || incident === null)
      ? "passed"
      : comparisons.some((c) => c.improved)
        ? "partial_relief"
        : "failed";

  const seriesId = mintSeriesId(engine.world);

  return ok(
    {
      series_id: seriesId,
      /** Always named, so a bare call is never ambiguous about what it verified (FR-10.1a). */
      action_id: action.id,
      action: action.summary,
      applied_at_s: sec(action.t),
      verified_at_s: sec(engine.world.nowMs),
      verdict,
      // FR-10.3 — a failure says which signals are still out of bounds.
      still_out_of_bounds: failing.map(
        (c) =>
          `${c.service}: error rate ${(c.error_rate.now * 100).toFixed(1)}% ` +
          `(needs <=${RECOVERY_ERROR_RATE * 100}%), p99 ${c.p99_ms.now}ms (needs <=${RECOVERY_P99_MS}ms)`,
      ),
      sustain_required_s: RECOVERY_SUSTAIN_SEC,
      comparisons,
    },
    [seriesId],
  );
}
