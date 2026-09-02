import { LOG_RETENTION, METRIC_RETENTION_SEC, TRACE_RETENTION } from "./constants";
import { SERVICE_NAMES } from "./world";
import type { LogEntry, MetricPoint, ServiceName, Trace } from "./types";

/**
 * Observation storage — ring buffers over what the simulation produced.
 *
 * These hold *observations*, never intentions. Nothing is written here that was not
 * computed from simulated request outcomes (FR-1.3), which is why the evidence sources
 * agree with each other by construction rather than by being written to agree (AC-2).
 */

export interface Store {
  metrics: Record<ServiceName, MetricPoint[]>;
  logs: LogEntry[];
  traces: Trace[];
}

export function createStore(): Store {
  const metrics = {} as Record<ServiceName, MetricPoint[]>;
  for (const name of SERVICE_NAMES) metrics[name] = [];
  return { metrics, logs: [], traces: [] };
}

export function pushMetric(store: Store, service: ServiceName, point: MetricPoint): void {
  const series = store.metrics[service];
  series.push(point);
  if (series.length > METRIC_RETENTION_SEC) series.shift();
}

export function pushLog(store: Store, entry: LogEntry): void {
  store.logs.push(entry);
  if (store.logs.length > LOG_RETENTION) store.logs.shift();
}

export function pushTrace(store: Store, trace: Trace): void {
  store.traces.push(trace);
  if (store.traces.length > TRACE_RETENTION) store.traces.shift();
}

/** Most recent metric point for a service, or null before the first second elapses. */
export function latestMetric(store: Store, service: ServiceName): MetricPoint | null {
  const series = store.metrics[service];
  return series.length > 0 ? series[series.length - 1]! : null;
}

/**
 * Mean of a signal over the last `seconds` of simulated time. Used for threshold
 * decisions, which must not react to a single noisy second.
 */
export function meanOver(
  store: Store,
  service: ServiceName,
  field: "errorRate" | "p99",
  seconds: number,
): number | null {
  const series = store.metrics[service];
  if (series.length === 0) return null;
  const slice = series.slice(-seconds);
  if (slice.length === 0) return null;
  let sum = 0;
  for (const p of slice) sum += p[field];
  return sum / slice.length;
}

export function metricsInWindow(
  store: Store,
  service: ServiceName,
  fromMs: number,
  toMs: number,
): MetricPoint[] {
  return store.metrics[service].filter((p) => p.t >= fromMs && p.t <= toMs);
}
