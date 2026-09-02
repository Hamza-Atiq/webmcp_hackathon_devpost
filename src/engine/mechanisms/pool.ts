import { GATEWAY_TIMEOUT_MS } from "../constants";

/**
 * Connection-pool queueing — the mechanism behind scenario 1.
 *
 * A request that touches the database checks out a pooled connection, holds it for
 * `holdMs`, and returns it. When arrivals outpace the pool's throughput the excess
 * requests queue, and the wait they experience is what shows up as latency. This is
 * modelled as a real queue carried across ticks, not as a formula evaluated fresh
 * each tick, because the queue's *state* is what makes recovery gradual and what
 * makes `waiters` a number worth putting in a log line.
 *
 * THE POOL IS SHARED AT THE SERVICE LEVEL, NOT PER-REPLICA — spec FR-9.2a. This is
 * load-bearing rather than incidental: with a per-replica pool, adding replicas would
 * multiply connection capacity and `scale_replicas` would fully resolve the incident,
 * contradicting the outcome matrix in FR-9.2. A shared pooler in front of the database
 * is standard production practice, and it makes scaling exactly what the matrix says
 * it is — partial relief that helps CPU and does nothing for the queue.
 *
 * Nothing here knows which scenario is active. It reads `poolMax` and reports what
 * queueing theory says follows (FR-1.4, FR-2.5).
 */

export interface PoolInput {
  /** Requests per second that touch the database. */
  dbRps: number;
  /** Connections in the shared pool. */
  poolMax: number;
  /** How long one request holds a connection, in ms. */
  holdMs: number;
  /** Requests already waiting, carried from the previous tick. */
  waiters: number;
  tickSec: number;
}

export interface PoolResult {
  /** Requests still waiting at the end of this tick. */
  waiters: number;
  /** Wait a new arrival can expect, in ms, by Little's law. */
  waitMs: number;
  /** Requests abandoned this tick because they hit the gateway timeout. */
  timedOut: number;
  connectionsInUse: number;
  /** Offered load over capacity. Above 1 the queue grows without bound. */
  utilisation: number;
  saturated: boolean;
}

export function stepPool(input: PoolInput): PoolResult {
  const { dbRps, poolMax, holdMs, waiters, tickSec } = input;

  const holdSec = holdMs / 1000;

  // Throughput of the pool: each connection completes 1/holdSec requests per second.
  const serviceRatePerSec = poolMax / holdSec;

  const arrivals = dbRps * tickSec;
  const capacityThisTick = serviceRatePerSec * tickSec;

  let queue = waiters + arrivals;
  const served = Math.min(queue, capacityThisTick);
  queue -= served;

  // Nobody waits longer than the gateway timeout. Once the queue reaches the length
  // that implies a full timeout of wait, every further arrival is abandoned as a 504.
  // This is what pins a saturated pool at a steady error rate instead of letting the
  // queue grow to infinity.
  const maxQueue = serviceRatePerSec * (GATEWAY_TIMEOUT_MS / 1000);
  let timedOut = 0;
  if (queue > maxQueue) {
    timedOut = queue - maxQueue;
    queue = maxQueue;
  }

  const waitMs = serviceRatePerSec > 0 ? (queue / serviceRatePerSec) * 1000 : GATEWAY_TIMEOUT_MS;

  // Concurrent demand by Little's law, capped by what the pool can actually hold.
  const demand = dbRps * holdSec;
  const connectionsInUse = Math.min(poolMax, demand + queue);

  const utilisation = serviceRatePerSec > 0 ? dbRps / serviceRatePerSec : Infinity;

  return {
    waiters: queue,
    waitMs,
    timedOut,
    connectionsInUse,
    utilisation,
    saturated: utilisation >= 1,
  };
}
