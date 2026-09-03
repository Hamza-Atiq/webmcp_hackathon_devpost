import type { World } from "../world";

/**
 * Scenario 5 — capacity.
 *
 * A flash sale drives checkout traffic to roughly three times its baseline. Nothing is
 * broken and nothing was deployed: the service is simply being asked for more than three
 * replicas can serve, and the queueing that follows is ordinary saturation.
 *
 * **No deployment exists inside the incident window (FR-2.4).** An agent that reaches for
 * `rollback_deployment` because a rollback fixed the last incident will roll back a
 * change that predates the spike, watch it be approved, and watch verification fail. That
 * is the exercise.
 *
 * The spike is applied to inbound demand and to nothing else. Every symptom — the latency
 * climb, the 503s, CPU at the ceiling — is what the saturation arithmetic in `sim.ts`
 * produces from it (FR-1.4).
 */

export const SPIKE_RPS = 1150;

export function onset(world: World): void {
  world.services["checkout-service"].inboundRps = SPIKE_RPS;
}
