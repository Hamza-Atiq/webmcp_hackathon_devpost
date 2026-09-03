import { nextId, scheduleConfigChange, type World } from "../world";

/**
 * Scenario 2 — resource exhaustion.
 *
 * A routine inventory-service release adds a cache that is never evicted. Each request
 * retains a few kilobytes, and nothing notices until the heap has no headroom left: the
 * collector starts running more often, latency climbs, and only much later does anything
 * actually fail.
 *
 * The ordering is the diagnosis. Memory moves first, latency second, errors last — so an
 * agent watching error rate alone arrives at the scene after every useful clue has
 * already been visible for a minute. Nothing here says "memory leak"; the deployment says
 * it extends a cache, which is what such a change usually says.
 *
 * Rolling it back stops the leak *and* replaces the processes holding it. Restarting
 * replaces the processes and leaves the build in place, so the heap simply fills again —
 * FR-9.3's temporary relief, arrived at by arithmetic rather than by a special case.
 */

/**
 * Bytes retained per request. Calibrated so a replica's heap crosses the collector's
 * onset within a couple of simulated minutes at inventory-service's demand — slow enough
 * that the metric visibly *climbs* rather than jumping, fast enough to fit a demo.
 */
export const LEAK_BYTES_PER_REQ = 24_000;

export function onset(world: World): void {
  world.deployments.push({
    id: nextId(world, "dep"),
    t: world.nowMs,
    service: "inventory-service",
    version: "v2.3.0",
    previousVersion: "v2.2.0",
    author: "r.mensah",
    diff: [
      { key: "LEAK_BYTES_PER_REQ", from: "0", to: String(LEAK_BYTES_PER_REQ) },
      { key: "STOCK_CACHE_ENTRIES", from: "10000", to: "unbounded" },
    ],
    summary: "Cache stock lookups for the lifetime of the request handler",
    rolledBack: false,
  });

  scheduleConfigChange(world, "inventory-service", "leakBytesPerReq", LEAK_BYTES_PER_REQ);
}
