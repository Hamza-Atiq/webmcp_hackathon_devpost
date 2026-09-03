/**
 * Every fixed value in the simulation, from spec FR-0.
 *
 * Nothing here may be re-invented elsewhere in the engine. If a number appears in a
 * mechanism or a scenario, it either derives from these or it is a property of that
 * scenario's mechanism — never a threshold in disguise.
 */

/** Simulated milliseconds advanced per tick. Fixed forever — FR-3.4a. */
export const TICK_MS = 250;
export const TICK_SEC = TICK_MS / 1000;
export const TICKS_PER_SIM_SECOND = 1000 / TICK_MS;

/** Speed multipliers offered in the UI — FR-3.2. */
export const SPEED_MULTIPLIERS = [1, 10, 60] as const;
export type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number];

/** Healthy baseline, per service, with no incident active. */
export const BASELINE_RPS = 450;
export const BASELINE_VARIATION = 0.1;
export const HEALTHY_ERROR_RATE = 0.005;
export const HEALTHY_P50_MS = 60;
export const HEALTHY_P95_MS = 120;
export const HEALTHY_P99_MS = 200;
export const HEALTHY_CPU = 0.45;
export const HEALTHY_MEMORY = 0.6;
export const DEFAULT_REPLICAS = 3;

/** An incident opens when either holds for this long. */
export const INCIDENT_ERROR_RATE_THRESHOLD = 0.02;
export const INCIDENT_P99_THRESHOLD_MS = 1000;
export const INCIDENT_SUSTAIN_SEC = 15;

/** Severity, evaluated on the worst affected service. */
export const SEV1_ERROR_RATE = 0.25;
export const SEV2_ERROR_RATE = 0.05;
export const SEV2_P99_MS = 3000;

/**
 * Seconds of signal averaged when classifying severity.
 *
 * Detection itself uses raw per-second values, because FR-0 already filters noise by
 * requiring a 15-second run. Classification smooths, so that one unlucky second cannot
 * escalate an incident to SEV-1 and leave that on the permanent record.
 */
export const SEVERITY_WINDOW_SEC = 5;

/** Verification passes only when both hold for this long — FR-0, FR-10.1. */
export const RECOVERY_ERROR_RATE = 0.01;
export const RECOVERY_P99_MS = 400;
export const RECOVERY_SUSTAIN_SEC = 30;

/** Requests exceeding this at the gateway are abandoned and returned as 504s. */
export const GATEWAY_TIMEOUT_MS = 3000;

/**
 * Worker-thread contention — the mechanism that makes FR-9.2a's "spreads CPU load" true.
 *
 * A request waiting on a connection is not free while it waits: it occupies a worker on
 * whichever replica accepted it. With the pool's queue divided between the replicas, a
 * service holding hundreds of blocked requests has little headroom left for the requests
 * that never touch the database at all, and starts refusing work it could otherwise serve.
 *
 * This is what separates the two irrelevant-looking actions in scenario 1's row of the
 * FR-9.2 matrix, and the separation is the whole reason the row is interesting:
 *
 * - `scale_replicas` divides the same queue between more workers, so pressure falls and
 *   the contention errors go with it. The pool is untouched, so the timeouts remain —
 *   **partial relief**, never a fix, at any replica count up to MAX_REPLICAS.
 * - `shift_traffic` moves requests to another instance serving the same database, so the
 *   pool sees the same demand and queues the same requests. Pressure is unchanged —
 *   **no effect**, which is what the matrix says and what the tests hold it to.
 *
 * Blocked requests per replica, over this, is the pressure. Below the onset a service
 * absorbs the contention; above it, it starts shedding.
 */
/**
 * What a shifted request still costs the service it was shifted away from.
 *
 * `shift_traffic` moves requests to peers; it does not stop them arriving. They are
 * received, matched to a route and forwarded, which is much cheaper than serving them
 * and is not free. Without this, moving half a service's traffic away and doubling its
 * replica count are the *same arithmetic* — both halve utilisation — and no capacity
 * scenario could ever distinguish "full fix" from "partial relief" (FR-9.2, scenario 5).
 *
 * It is a property of forwarding, not of any scenario, so it applies everywhere: in
 * scenario 1 it changes nothing, because that incident is a queue on a shared pool and
 * not a shortage of CPU.
 */
export const FORWARD_COST = 0.35;

/**
 * Garbage-collection pressure — the mechanism behind scenario 2.
 *
 * A heap that is filling does not fail at 100% and behave perfectly at 99%. The collector
 * runs more often and holds the process longer as headroom disappears, so latency climbs
 * first and requests start being refused only near the ceiling. That ordering is what
 * makes the scenario diagnosable: memory is the signal that moved first, and an agent
 * that reads only error rate will be looking at the last symptom rather than the first.
 *
 * Onset well below the ceiling, because a service spending its time collecting is already
 * degraded even though nothing has failed yet.
 */
export const GC_ONSET = 0.7;
export const GC_LATENCY_GAIN = 0.55;
export const GC_ERROR_ONSET = 0.9;
export const GC_ERROR_GAIN = 1.6;
export const GC_ERROR_MAX = 0.35;

export const WORKERS_PER_REPLICA = 120;
export const CONTENTION_ONSET = 0.4;
export const CONTENTION_ERROR_GAIN = 0.15;
export const CONTENTION_ERROR_MAX = 0.08;
export const CONTENTION_LATENCY_GAIN = 1.6;
export const CONTENTION_CPU_GAIN = 0.85;

/**
 * How long a configuration change takes to roll out across replicas, in simulated ms.
 * This is why no action produces instant recovery (FR-9.1): a rollback is a rolling
 * restart, so capacity returns progressively and the queue drains over time rather
 * than snapping back on the tick the action is applied.
 */
export const ROLLOUT_MS = 45_000;

/**
 * How long a rolling restart takes, in simulated ms, and the share of traffic that fails
 * while it runs. Replicas cycle one at a time, so roughly one replica's worth of requests
 * is failing at any moment rather than all of them.
 */
export const RESTART_MS = 8_000;

/**
 * The most traffic `shift_traffic` may route away. Not 100%: a service with no traffic
 * has no signals, and an action that makes an incident *unobservable* rather than fixed
 * would look like a recovery to any metric-based verdict.
 */
export const TRAFFIC_SHIFT_MAX = 0.9;

/** Limits — FR-0. */
export const MAX_PENDING_PROPOSALS = 3;
export const APPROVAL_TIMEOUT_MS = 60_000;
export const HEALTHY_WINDOW_MS = 20_000;

/**
 * Retention. Ring buffers, sized in simulated time or record count.
 *
 * Trace retention has to be read together with the capture rates below. A log line that cites a
 * trace id is only useful while that trace still exists, and traces evict far faster than logs
 * because there are more of them. Measured on the live page before these numbers were chosen:
 * capturing every failure at 450 rps produced ~40 traces a second, so a 400-trace buffer held ten
 * seconds of history and 96% of correlation ids pointed at nothing.
 */
export const METRIC_RETENTION_SEC = 1800;
export const LOG_RETENTION = 4000;
export const TRACE_RETENTION = 3000;

/** Fraction of successful requests captured as a full trace. */
export const TRACE_SAMPLE_RATE = 0.002;

/**
 * Failed requests are sampled too, not captured wholesale.
 *
 * Tail-based sampling with a per-second cap is what real tracing does, and without it a saturated
 * service alone produces enough traces to evict the buffer every ten seconds. Four a second still
 * gives an investigator dozens of failures to open within any window they care about.
 */
export const ERROR_TRACES_PER_SECOND = 4;

/**
 * Correlated error log lines per service per simulated second.
 *
 * One. Measured on the live page at two: correlated failures reached 853 of 991 log lines and
 * buried the pool-saturation lines that actually explain the incident. The aggregate failure count
 * belongs in the metrics; the log needs enough examples to follow, not every instance.
 */
export const CORRELATED_LOGS_PER_SECOND = 1;
