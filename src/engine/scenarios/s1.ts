import { nextId, scheduleConfigChange, type World } from "../world";

/**
 * Scenario 1 — config regression.
 *
 * A routine deployment of checkout-service ships a change that reduces the shared
 * database connection pool from 50 to 5, made by someone trimming memory usage without
 * understanding what the pool was for.
 *
 * Nothing in this file describes the *symptoms*. It changes one configuration value and
 * records the deployment that changed it. The latency climb, the 504s, the growing
 * waiter count and the shape of the traces are all consequences the simulation computes
 * (FR-1.4). That is what makes the agent's investigation real: the answer is not written
 * down anywhere for it to find.
 */

export const SCENARIO_1_ID = "s1";

export function onset(world: World): void {
  world.deployments.push({
    id: nextId(world, "dep"),
    t: world.nowMs,
    service: "checkout-service",
    version: "v2.4.1",
    previousVersion: "v2.4.0",
    author: "d.okafor",
    diff: [
      { key: "DB_POOL_MAX", from: "50", to: "5" },
      { key: "LOG_LEVEL", from: "info", to: "warn" },
    ],
    summary: "Reduce connection pool footprint to cut memory usage",
    rolledBack: false,
  });

  scheduleConfigChange(world, "checkout-service", "dbPoolMax", 5);
}
