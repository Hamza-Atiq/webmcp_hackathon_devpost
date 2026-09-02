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

/** Verification passes only when both hold for this long — FR-0, FR-10.1. */
export const RECOVERY_ERROR_RATE = 0.01;
export const RECOVERY_P99_MS = 400;
export const RECOVERY_SUSTAIN_SEC = 30;

/** Requests exceeding this at the gateway are abandoned and returned as 504s. */
export const GATEWAY_TIMEOUT_MS = 3000;

/**
 * How long a configuration change takes to roll out across replicas, in simulated ms.
 * This is why no action produces instant recovery (FR-9.1): a rollback is a rolling
 * restart, so capacity returns progressively and the queue drains over time rather
 * than snapping back on the tick the action is applied.
 */
export const ROLLOUT_MS = 45_000;

/** Limits — FR-0. */
export const MAX_PENDING_PROPOSALS = 3;
export const APPROVAL_TIMEOUT_MS = 60_000;
export const HEALTHY_WINDOW_MS = 20_000;

/** Retention. Ring buffers, sized in simulated time or record count. */
export const METRIC_RETENTION_SEC = 1800;
export const LOG_RETENTION = 4000;
export const TRACE_RETENTION = 400;

/** Fraction of requests captured as a full trace. Errors are always captured. */
export const TRACE_SAMPLE_RATE = 0.02;
