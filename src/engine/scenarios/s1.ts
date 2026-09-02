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

/** Deployment history that exists before the incident, so rollback always has a target (FR-2.4a). */
export function seedHistory(world: World): void {
  world.deployments.push({
    id: nextId(world, "dep"),
    t: -6 * 60 * 60 * 1000,
    service: "checkout-service",
    version: "v2.4.0",
    previousVersion: "v2.3.8",
    author: "priya.raman",
    diff: [{ key: "CHECKOUT_RETRY_BACKOFF_MS", from: "100", to: "150" }],
    summary: "Increase retry backoff on payment calls",
    rolledBack: false,
  });

  world.deployments.push({
    id: nextId(world, "dep"),
    t: -3 * 60 * 60 * 1000,
    service: "user-service",
    version: "v1.9.2",
    previousVersion: "v1.9.1",
    author: "tom.becker",
    diff: [{ key: "SESSION_CACHE_TTL_S", from: "300", to: "600" }],
    summary: "Extend session cache TTL",
    rolledBack: false,
  });
}

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
