import { scheduleConfigChange, type World } from "../world";

/**
 * Scenario 3 — dependency failure.
 *
 * The external fraud-scoring provider payment-service has always called starts taking
 * twenty times longer to answer. Nothing was deployed, nothing was configured, and no
 * code in this repository changed: an upstream everyone depends on and nobody controls
 * got slower, its forty concurrent slots stopped clearing, and authorisations began
 * queueing behind it.
 *
 * **There is no deployment inside the incident window (FR-2.4).** payment-service's most
 * recent release predates the degradation by hours and `list_recent_deployments` says so.
 * An agent that rolls back anyway will have it approved, applied, and verified as failed —
 * which is the lesson, and why refusing the call would teach nothing (FR-2.4a).
 *
 * The fix is not to repair the provider, which is not ours to repair. It is to stop
 * calling it: `payment_fraud_check_v2` gates the call, and turning it off removes the
 * queue entirely. Moving traffic away helps because a peer region scores against its own
 * endpoint, so the calls that remain queue behind fewer others — relief, not a fix, since
 * the provider is exactly as slow as it was.
 */

/**
 * Healthy is 45ms. This is the provider under duress, not a provider that is down.
 *
 * Sixty concurrent slots clear 200 calls a second at this hold time against roughly 256
 * arriving, so the queue fills to the caller's budget and about a fifth of scoring calls
 * are abandoned. Everything that does not need scoring is served normally throughout,
 * which is exactly the shape that makes a dependency problem hard to see from the top.
 *
 * Moving traffic away drains the queue but does not make the provider fast: the calls
 * that remain still take 300ms instead of 45, so latency stays outside the recovery
 * threshold and the incident stays open. Relief, measured, and not a fix — because the
 * provider is exactly as slow as it was.
 */
export const DEGRADED_PROVIDER_MS = 300;

export function onset(world: World): void {
  scheduleConfigChange(world, "payment-service", "externalHoldMs", DEGRADED_PROVIDER_MS, 8000);
}
