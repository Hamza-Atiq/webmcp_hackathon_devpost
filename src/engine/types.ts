/** Core domain types for the simulated production environment. */

export type ServiceName =
  | "api-gateway"
  | "checkout-service"
  | "payment-service"
  | "inventory-service"
  | "user-service";

export type HealthStatus = "healthy" | "degraded" | "critical";

export type Severity = "SEV-1" | "SEV-2" | "SEV-3";

export type IncidentStatus =
  | "detected"
  | "investigating"
  | "identified"
  | "mitigating"
  | "resolved";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Which evidence source an id came from. FR-7.2 requires two *different* sources. */
export type EvidenceSource =
  | "metrics"
  | "logs"
  | "traces"
  | "deployments"
  | "runbooks"
  | "ownership"
  | "incident";

/**
 * Mutable runtime configuration of one service. This is what remediation actions
 * change, and what the mechanisms read. Nothing here names a scenario — the
 * degradation is a consequence of these values (FR-1.4, FR-2.5).
 */
export interface ServiceConfig {
  /** Shared connection-pool size. See mechanisms/pool.ts for why it is not per-replica. */
  dbPoolMax: number;
  /** How long a request holds a pooled connection, in ms. */
  dbHoldMs: number;
  /** Fraction of requests that touch the database at all. */
  dbFraction: number;
  /** Median non-database processing time, in ms. */
  baseMs: number;
  /** Lognormal shape for processing time — controls the p50-to-p99 spread. */
  sigma: number;
  replicas: number;
  /** Requests per second one replica can serve before saturation costs latency. */
  capacityPerReplica: number;
  /** Heap bytes leaked per served request. Zero unless a leaking version is deployed. */
  leakBytesPerReq: number;
  /** Heap ceiling in bytes; crossing it forces restarts and failures. */
  heapLimitBytes: number;
}

export interface ServiceState {
  name: ServiceName;
  config: ServiceConfig;
  /** Services this one calls. */
  dependencies: ServiceName[];
  /** Inbound request rate, requests per second. */
  inboundRps: number;
  /** Bytes currently held on the heap; reset by restart_service. */
  heapBytes: number;
  /** Requests waiting for a pooled connection right now. */
  waiters: number;
  /** Connections currently checked out. */
  connectionsInUse: number;
  /** Fraction of this service's traffic diverted elsewhere by shift_traffic. */
  trafficShiftedAway: number;
  /** Sim-ms at which the process last started; restart_service resets it. */
  startedAtMs: number;
}

/** One second of aggregated observations for one service. */
export interface MetricPoint {
  /** Simulated milliseconds since T0. */
  t: number;
  requests: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  cpu: number;
  memory: number;
  replicas: number;
}

export interface LogEntry {
  id: string;
  t: number;
  service: ServiceName;
  level: LogLevel;
  message: string;
  /** Ties a log line to the trace it came from, when there is one. */
  correlationId?: string;
}

export interface Span {
  name: string;
  service: ServiceName;
  startMs: number;
  durationMs: number;
  error?: string;
  children: Span[];
}

export interface Trace {
  id: string;
  t: number;
  service: ServiceName;
  durationMs: number;
  status: "ok" | "error";
  root: Span;
}

export interface Deployment {
  id: string;
  t: number;
  service: ServiceName;
  version: string;
  previousVersion: string | null;
  author: string;
  /** Configuration changes this deployment introduced. */
  diff: Array<{ key: string; from: string; to: string }>;
  /** Human-readable summary shown in the deployment list. */
  summary: string;
  /** True once rolled back, so a second rollback is not offered. */
  rolledBack: boolean;
}

export interface FeatureFlag {
  key: string;
  service: ServiceName;
  enabled: boolean;
  description: string;
}

export interface TimelineEntry {
  t: number;
  actor: "system" | "human" | "agent";
  message: string;
}

export interface Incident {
  id: string;
  openedAt: number;
  severity: Severity;
  status: IncidentStatus;
  affectedServices: ServiceName[];
  timeline: TimelineEntry[];
  resolvedAt: number | null;
}
