import { nextId, scheduleConfigChange, type World } from "../world";

/**
 * Scenario 4 — bad migration, and the sharpest trap of the five.
 *
 * A standalone schema migration is running against the user-service database and holding
 * locks on the tables the application reads through. Queries wait, the connection pool
 * fills with waiting transactions, and requests start timing out.
 *
 * **A recent user-service deployment exists and correlates in time — and it is not the
 * cause** (FR-2.4b). It extends a session cache, it went out minutes before the incident,
 * and rolling it back is executable, plausible and useless. The migration is a separate
 * job that no deployment record describes, which is exactly why the deployment list is a
 * trap rather than an answer: correlation in time is not causation, and this scenario is
 * where an agent either demonstrates that or does not.
 *
 * The fix is not to un-run the migration, which cannot be un-run. It is to stop reading
 * through the schema it is migrating: `user_profile_schema_v2` gates that path.
 *
 * And scaling makes it worse, measurably (FR-9.4). More replicas open more connections,
 * more concurrent transactions contend for the same locks, and the wait grows. It is the
 * one cell in FR-9.2's matrix where the obvious thing to do is the wrong thing to do.
 */

/**
 * Lock wait at baseline concurrency, in ms.
 *
 * Calibrated against user-service's own numbers: forty pooled connections held for 30ms
 * clear far more than the ~46 database requests a second it receives, so nothing queues
 * until a query starts taking most of a second. At this figure the pool tips just past
 * saturation at three replicas, is comfortably past it at six, and drains at three when
 * half the traffic is served elsewhere.
 */
export const MIGRATION_LOCK_MS = 1200;

export function onset(world: World): void {
  world.deployments.push({
    id: nextId(world, "dep"),
    t: world.nowMs,
    service: "user-service",
    version: "v1.9.3",
    previousVersion: "v1.9.2",
    author: "s.iqbal",
    diff: [
      { key: "SESSION_CACHE_TTL", from: "300", to: "900" },
      { key: "LOG_LEVEL", from: "info", to: "info" },
    ],
    summary: "Raise session cache TTL and add a profile read-through",
    rolledBack: false,
  });

  scheduleConfigChange(world, "user-service", "migrationLockMs", MIGRATION_LOCK_MS, 10000);
}
