import {
  CONTENTION_CPU_GAIN,
  FORWARD_COST,
  GC_ERROR_GAIN,
  GC_ERROR_MAX,
  GC_ERROR_ONSET,
  GC_LATENCY_GAIN,
  GC_ONSET,
  CONTENTION_ERROR_GAIN,
  CONTENTION_ERROR_MAX,
  CONTENTION_LATENCY_GAIN,
  CONTENTION_ONSET,
  WORKERS_PER_REPLICA,
  BASELINE_VARIATION,
  CORRELATED_LOGS_PER_SECOND,
  ERROR_TRACES_PER_SECOND,
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
  /** Correlated error logs already emitted this simulated second, per service. */
  correlatedThisSec: Record<ServiceName, number>;
  /** Error traces already captured this simulated second, per service. */
  errorTracesThisSec: Record<ServiceName, number>;
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
  const correlatedThisSec = {} as Record<ServiceName, number>;
  const errorTracesThisSec = {} as Record<ServiceName, number>;
  for (const name of SERVICE_NAMES) {
    acc[name] = newAccumulator(0);
    remainder[name] = 0;
    lastPoolLogSec[name] = -1;
    correlatedThisSec[name] = 0;
    errorTracesThisSec[name] = 0;
  }
  return { world, store, acc, remainder, lastPoolLogSec, correlatedThisSec, errorTracesThisSec };
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
    /*
     * Shifted traffic is *served elsewhere*, not deleted.
     *
     * This distinction decides whether the product's premise holds. When shifting simply
     * removed load, `shift_traffic` drained the connection pool and fully resolved
     * scenario 1 — a second universal fix, which FR-9.2's failure test calls void.
     * Measured, not reasoned about: 10.77% error and 3105ms p99 went to 0.00% and 116ms.
     *
     * What actually happens when traffic moves away from a service is that some other
     * instance answers it — against the same database. So the requests this service still
     * serves fall (`localRps`, which is what its own metrics count and what its replicas
     * must be sized for), while the shared connection pool goes on seeing the whole
     * demand. That is the same argument FR-9.2a makes for replicas, and it is why moving
     * traffic relieves a service that is itself the bottleneck and does nothing at all for
     * one queueing on a resource it shares.
     */
    const variation = 1 + world.rng.range(-BASELINE_VARIATION, BASELINE_VARIATION);
    const offeredRps = service.inboundRps * variation;
    const rps = offeredRps * (1 - service.trafficShiftedAway);

    const exact = rps * TICK_SEC + sim.remainder[name];
    const count = Math.floor(exact);
    sim.remainder[name] = exact - count;

    // --- saturation ---------------------------------------------------------
    /*
     * Utilisation counts what the service *handles*, which is more than what it serves:
     * a request routed to a peer still arrives here to be forwarded. See FORWARD_COST —
     * it is the only reason scaling and shifting are not the same arithmetic.
     */
    const forwarded = offeredRps * service.trafficShiftedAway * FORWARD_COST;
    const handledRps = rps + forwarded;
    const util =
      cfg.capacityPerReplica > 0 ? handledRps / cfg.replicas / cfg.capacityPerReplica : 0;
    const satFactor =
      util <= SATURATION_KNEE ? 1 : 1 + (util - SATURATION_KNEE) / Math.max(0.02, 1 - util);
    const satErrorRate = util > 1 ? Math.min(0.5, (util - 1) * 0.8) : 0;

    /*
     * A rolling restart cycles replicas one at a time, so roughly one replica's share of
     * requests is refused at any moment rather than all of them (FR-9). This is why
     * restarting is visibly a *cost* paid up front: the signals get worse before whatever
     * the restart cleared has any chance to help.
     */
    const restartErrorRate =
      world.nowMs < service.restartingUntilMs && cfg.replicas > 0 ? 1 / cfg.replicas : 0;

    // --- connection pool ----------------------------------------------------
    // The pool is shared across every instance serving this service, so it sees the whole
    // offered load regardless of which instance answered — see the note above.
    const dbRps = offeredRps * cfg.dbFraction;
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

    /*
     * Worker-thread contention — FR-9.2a.
     *
     * Every request parked on the pool is holding a worker on the replica that accepted
     * it. Divided between the replicas, that queue is what leaves a service with no
     * headroom for the requests that never touch the database, and it is the only
     * channel through which `scale_replicas` can help here: more replicas divide the
     * same queue, while the queue itself belongs to the shared pool and neither shrinks
     * when traffic is moved elsewhere nor grows when it is not.
     *
     * Derived from `service.waiters`, which the pool step above has just updated, and
     * therefore zero for a healthy service and for every service with no pool at all.
     * The healthy baseline is untouched by this.
     */
    /*
     * The heap, and what it costs — FR-9.3's mechanism.
     *
     * `heapBytes` is one typical replica's heap, so growth is the service's *demand*
     * divided between its replicas. Demand, not locally served traffic: requests routed
     * to a peer are served by another copy of the same leaking build, and every replica
     * runs it. That is what makes `shift_traffic` worthless here and `scale_replicas`
     * worth something — one moves the leak, the other divides it.
     */
    if (cfg.leakBytesPerReq > 0 && cfg.replicas > 0) {
      service.heapBytes += (cfg.leakBytesPerReq * offeredRps * TICK_SEC) / cfg.replicas;
    }
    const heapFraction =
      cfg.heapLimitBytes > 0 ? Math.min(1, service.heapBytes / cfg.heapLimitBytes) : 0;
    const gcFactor =
      heapFraction <= GC_ONSET
        ? 1
        : 1 + ((heapFraction - GC_ONSET) * GC_LATENCY_GAIN) / Math.max(0.02, 1 - heapFraction);
    const gcErrorRate =
      heapFraction > GC_ERROR_ONSET
        ? Math.min(GC_ERROR_MAX, (heapFraction - GC_ERROR_ONSET) * GC_ERROR_GAIN)
        : 0;

    const blockedPerReplica = cfg.replicas > 0 ? service.waiters / cfg.replicas : 0;
    const pressure = blockedPerReplica / WORKERS_PER_REPLICA;
    const contentionFactor = 1 + pressure * CONTENTION_LATENCY_GAIN;
    const contentionErrorRate =
      pressure > CONTENTION_ONSET
        ? Math.min(CONTENTION_ERROR_MAX, (pressure - CONTENTION_ONSET) * CONTENTION_ERROR_GAIN)
        : 0;

    // --- per-request outcomes ----------------------------------------------
    // Every metric, log and trace below is computed from these samples. Nothing is
    // read from a fixture or keyed on which scenario is active (FR-1.3, FR-1.4).
    for (let i = 0; i < count; i++) {
      const touchesDb = cfg.dbFraction > 0 && world.rng.chance(cfg.dbFraction);

      let latency =
        world.rng.lognormal(cfg.baseMs, cfg.sigma) * satFactor * contentionFactor * gcFactor;
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

      /*
       * Refused for want of a worker, not for want of a connection. A distinct failure
       * string because it is distinct evidence: it is the line that tells an agent the
       * service is shedding load it could otherwise serve, which is the part adding
       * replicas can address.
       */
      if (!failed && contentionErrorRate > 0 && world.rng.chance(contentionErrorRate)) {
        failed = true;
        failure = "worker pool exhausted: no thread available to accept the request";
      }

      if (!failed && gcErrorRate > 0 && world.rng.chance(gcErrorRate)) {
        failed = true;
        failure = "allocation failed: heap exhausted while the collector was running";
      }

      if (!failed && restartErrorRate > 0 && world.rng.chance(restartErrorRate)) {
        failed = true;
        failure = "connection refused: replica restarting";
      }

      // Background failure rate every real service has. Flagged as routine: a healthy
      // service returning the odd 500 is not news, and logging one every second would
      // make every service look like it were in trouble.
      let routine = false;
      if (!failed && world.rng.chance(0.002)) {
        failed = true;
        routine = true;
        failure = "upstream returned 500";
      }

      acc.latencies.push(latency);
      acc.requests += 1;
      if (failed) acc.errors += 1;

      // Traces: a small sample of successes, plus failures up to a per-second cap. The
      // `failed ||` short-circuit is deliberate — a failed request draws no sample number,
      // and changing that would shift every subsequent draw and break replay (FR-1.5).
      const capture = failed
        ? sim.errorTracesThisSec[name] < ERROR_TRACES_PER_SECOND
        : world.rng.chance(TRACE_SAMPLE_RATE);

      if (capture) {
        if (failed) sim.errorTracesThisSec[name] += 1;
        const traceId = recordTrace(sim, name, latency, acquireMs, queryMs, failed, failure);

        // A notable failure also says so in the log, carrying the trace id. This is the link
        // that lets an agent move from "the logs mention timeouts" to "here is the request
        // that timed out, and here is where its time went" (FR-4.2, FR-4.8). Emitted only
        // alongside a captured trace, so the id it cites always exists when written.
        if (failed && !routine && sim.correlatedThisSec[name] < CORRELATED_LOGS_PER_SECOND) {
          sim.correlatedThisSec[name] += 1;
          pushLog(store, {
            id: nextId(world, "log"),
            t: world.nowMs,
            service: name,
            level: "error",
            message: `request failed after ${Math.round(latency)}ms: ${failure}`,
            correlationId: traceId,
          });
        }
      }
    }

    acc.cpu = Math.min(1, util + pressure * CONTENTION_CPU_GAIN);
    acc.memory = heapFraction;

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
): string {
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

  const traceId = nextId(world, "trc");

  pushTrace(store, {
    id: traceId,
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

  return traceId;
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
    sim.correlatedThisSec[name] = 0;
    sim.errorTracesThisSec[name] = 0;
  }

  // Detection runs on the second that has just closed, so an incident opens from the
  // same numbers the dashboard and the tools report — never from a private signal.
  evaluateIncident(world, store, points);
}
