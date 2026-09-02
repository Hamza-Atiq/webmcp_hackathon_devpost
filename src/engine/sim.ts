import {
  BASELINE_VARIATION,
  GATEWAY_TIMEOUT_MS,
  TICK_MS,
  TICK_SEC,
  TRACE_SAMPLE_RATE,
} from "./constants";
import { evaluateIncident } from "./incident";
import { stepPool } from "./mechanisms/pool";
import { applyTransitions, nextId, SERVICE_NAMES, type World } from "./world";
import { pushLog, pushMetric, pushTrace, type Store } from "./store";
import type { MetricPoint, ServiceName, Span } from "./types";

/**
 * One tick of the world.
 *
 * Fixed size, always TICK_MS of simulated time (FR-3.4a). The speed multiplier changes
 * how many ticks a real second consumes, never what a tick does — so a run at 60x and a
 * run at 1x produce identical evidence (FR-3.4).
 *
 * The random generator is advanced here and nowhere else, in a fixed service order. A
 * tool call or a render that consumed a draw would make the run depend on observation.
 */

interface Accumulator {
  second: number;
  latencies: number[];
  requests: number;
  errors: number;
  cpu: number;
  memory: number;
  /** Carried so the log emitter can describe the pool honestly. */
  waiters: number;
  connectionsInUse: number;
  poolSaturated: boolean;
}

export interface Sim {
  world: World;
  store: Store;
  acc: Record<ServiceName, Accumulator>;
  /** Fractional requests carried between ticks so throughput is exact, not rounded. */
  remainder: Record<ServiceName, number>;
  /** Suppresses repeat log lines so a saturated pool does not emit 4 lines a second. */
  lastPoolLogSec: Record<ServiceName, number>;
}

/** Utilisation above which queueing starts to cost noticeable latency. */
const SATURATION_KNEE = 0.7;

function newAccumulator(second: number): Accumulator {
  return {
    second,
    latencies: [],
    requests: 0,
    errors: 0,
    cpu: 0,
    memory: 0,
    waiters: 0,
    connectionsInUse: 0,
    poolSaturated: false,
  };
}

export function createSim(world: World, store: Store): Sim {
  const acc = {} as Record<ServiceName, Accumulator>;
  const remainder = {} as Record<ServiceName, number>;
  const lastPoolLogSec = {} as Record<ServiceName, number>;
  for (const name of SERVICE_NAMES) {
    acc[name] = newAccumulator(0);
    remainder[name] = 0;
    lastPoolLogSec[name] = -1;
  }
  return { world, store, acc, remainder, lastPoolLogSec };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function tick(sim: Sim): void {
  const { world, store } = sim;

  world.nowMs += TICK_MS;
  world.tick += 1;
  applyTransitions(world);

  const secondBefore = Math.floor((world.nowMs - TICK_MS) / 1000);
  const secondNow = Math.floor(world.nowMs / 1000);
  const crossedSecond = secondNow !== secondBefore;

  for (const name of SERVICE_NAMES) {
    const service = world.services[name];
    const cfg = service.config;
    const acc = sim.acc[name];

    // --- offered load -------------------------------------------------------
    const variation = 1 + world.rng.range(-BASELINE_VARIATION, BASELINE_VARIATION);
    const rps = service.inboundRps * (1 - service.trafficShiftedAway) * variation;

    const exact = rps * TICK_SEC + sim.remainder[name];
    const count = Math.floor(exact);
    sim.remainder[name] = exact - count;

    // --- saturation ---------------------------------------------------------
    const util = cfg.capacityPerReplica > 0 ? rps / cfg.replicas / cfg.capacityPerReplica : 0;
    const satFactor =
      util <= SATURATION_KNEE ? 1 : 1 + (util - SATURATION_KNEE) / Math.max(0.02, 1 - util);
    const satErrorRate = util > 1 ? Math.min(0.5, (util - 1) * 0.8) : 0;

    // --- connection pool ----------------------------------------------------
    const dbRps = rps * cfg.dbFraction;
    let waitMs = 0;
    let timeoutShare = 0;

    if (cfg.dbPoolMax > 0 && cfg.dbFraction > 0) {
      const pool = stepPool({
        dbRps,
        poolMax: cfg.dbPoolMax,
        holdMs: cfg.dbHoldMs,
        waiters: service.waiters,
        tickSec: TICK_SEC,
      });
      service.waiters = pool.waiters;
      service.connectionsInUse = pool.connectionsInUse;
      waitMs = pool.waitMs;
      acc.waiters = pool.waiters;
      acc.connectionsInUse = pool.connectionsInUse;
      acc.poolSaturated = pool.saturated;

      const dbArrivals = dbRps * TICK_SEC;
      timeoutShare = dbArrivals > 0 ? Math.min(1, pool.timedOut / dbArrivals) : 0;
    }

    // --- per-request outcomes ----------------------------------------------
    // Every metric, log and trace below is computed from these samples. Nothing is
    // read from a fixture or keyed on which scenario is active (FR-1.3, FR-1.4).
    for (let i = 0; i < count; i++) {
      const touchesDb = cfg.dbFraction > 0 && world.rng.chance(cfg.dbFraction);

      let latency = world.rng.lognormal(cfg.baseMs, cfg.sigma) * satFactor;
      let acquireMs = 0;
      let queryMs = 0;
      let failed = false;
      let failure = "";

      if (touchesDb) {
        acquireMs = waitMs;
        queryMs = world.rng.lognormal(cfg.dbHoldMs, 0.2);
        latency += acquireMs + queryMs;

        if (timeoutShare > 0 && world.rng.chance(timeoutShare)) {
          failed = true;
          failure = "gateway timeout waiting for a database connection";
          latency = GATEWAY_TIMEOUT_MS;
        }
      }

      if (!failed && satErrorRate > 0 && world.rng.chance(satErrorRate)) {
        failed = true;
        failure = "service overloaded";
      }

      // Background failure rate every real service has.
      if (!failed && world.rng.chance(0.002)) {
        failed = true;
        failure = "upstream returned 500";
      }

      acc.latencies.push(latency);
      acc.requests += 1;
      if (failed) acc.errors += 1;

      // Traces: a small sample, plus every failure, so the tail is always inspectable.
      if (failed || world.rng.chance(TRACE_SAMPLE_RATE)) {
        recordTrace(sim, name, latency, acquireMs, queryMs, failed, failure);
      }
    }

    acc.cpu = Math.min(1, util);
    acc.memory =
      cfg.heapLimitBytes > 0 ? Math.min(1, service.heapBytes / cfg.heapLimitBytes) : 0;

    // --- log lines describing real pool state -------------------------------
    if (acc.poolSaturated && sim.lastPoolLogSec[name] !== secondNow) {
      sim.lastPoolLogSec[name] = secondNow;
      pushLog(store, {
        id: nextId(world, "log"),
        t: world.nowMs,
        service: name,
        level: "error",
        message:
          `pool exhausted: ${Math.round(acc.connectionsInUse)}/${Math.round(cfg.dbPoolMax)} ` +
          `connections in use, ${Math.round(acc.waiters)} waiters, ` +
          `mean acquire ${Math.round(waitMs)}ms`,
      });
    }
  }

  if (crossedSecond) finaliseSecond(sim, secondNow);
}

function recordTrace(
  sim: Sim,
  service: ServiceName,
  totalMs: number,
  acquireMs: number,
  queryMs: number,
  failed: boolean,
  failure: string,
): void {
  const { world, store } = sim;
  const children: Span[] = [];
  let cursor = 0;

  const appMs = Math.max(0, totalMs - acquireMs - queryMs);

  if (acquireMs > 0 || queryMs > 0) {
    children.push({
      name: "db.acquire_connection",
      service,
      startMs: cursor,
      durationMs: acquireMs,
      ...(failed ? { error: failure } : {}),
      children: [],
    });
    cursor += acquireMs;
    children.push({
      name: "db.query",
      service,
      startMs: cursor,
      durationMs: queryMs,
      children: [],
    });
    cursor += queryMs;
  }

  children.push({
    name: "app.handler",
    service,
    startMs: cursor,
    durationMs: appMs,
    children: [],
  });

  pushTrace(store, {
    id: nextId(world, "trc"),
    t: world.nowMs,
    service,
    durationMs: totalMs,
    status: failed ? "error" : "ok",
    root: {
      name: `${service} request`,
      service,
      startMs: 0,
      durationMs: totalMs,
      ...(failed ? { error: failure } : {}),
      children,
    },
  });
}

function finaliseSecond(sim: Sim, second: number): void {
  const { world, store } = sim;
  const points: Partial<Record<ServiceName, MetricPoint>> = {};

  for (const name of SERVICE_NAMES) {
    const acc = sim.acc[name];
    const service = world.services[name];

    if (acc.requests > 0) {
      const sorted = acc.latencies.slice().sort((a, b) => a - b);
      const point: MetricPoint = {
        t: world.nowMs,
        requests: acc.requests,
        errors: acc.errors,
        errorRate: acc.errors / acc.requests,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        cpu: acc.cpu,
        memory: acc.memory,
        replicas: Math.round(service.config.replicas),
      };
      pushMetric(store, name, point);
      points[name] = point;
    }

    sim.acc[name] = newAccumulator(second);
  }

  // Detection runs on the second that has just closed, so an incident opens from the
  // same numbers the dashboard and the tools report — never from a private signal.
  evaluateIncident(world, store, points);
}
