import { createRng, type Rng } from "./prng";
import { DEFAULT_REPLICAS, ROLLOUT_MS } from "./constants";
import type {
  Deployment,
  FeatureFlag,
  Incident,
  ServiceConfig,
  ServiceName,
  ServiceState,
} from "./types";
import type { AppliedAction } from "./actions";

/**
 * The simulated production environment.
 *
 * Every number a tool can observe is derived from this state by the tick function.
 * Nothing here records which scenario is active, what the "expected" error rate is,
 * or what the correct remediation would be (FR-1.3, FR-1.4, FR-2.5). A scenario is
 * just an initial edit to these values; the degradation is arithmetic downstream.
 */

export const SERVICE_NAMES: ServiceName[] = [
  "api-gateway",
  "checkout-service",
  "payment-service",
  "inventory-service",
  "user-service",
];

interface ServiceDef {
  config: ServiceConfig;
  dependencies: ServiceName[];
  /** Requests per second arriving at this service in the healthy baseline. */
  baseRps: number;
}

const HEAP_LIMIT = 512 * 1024 * 1024;

/**
 * Calibrated so the healthy state sits inside every FR-0 threshold while leaving
 * checkout-service's shared pool close enough to its knee that the 50 -> 5 regression
 * pushes it past saturation. See the commit that raised baseline throughput to 450 rps
 * for the arithmetic.
 */
const SERVICE_DEFS: Record<ServiceName, ServiceDef> = {
  "api-gateway": {
    baseRps: 450,
    dependencies: ["checkout-service", "user-service"],
    config: {
      dbPoolMax: 0,
      dbHoldMs: 0,
      dbFraction: 0,
      baseMs: 4,
      sigma: 0.25,
      replicas: DEFAULT_REPLICAS,
      capacityPerReplica: 400,
      leakBytesPerReq: 0,
      heapLimitBytes: HEAP_LIMIT,
    },
  },
  "checkout-service": {
    baseRps: 320,
    dependencies: ["payment-service", "inventory-service"],
    config: {
      dbPoolMax: 50,
      dbHoldMs: 60,
      dbFraction: 0.35,
      baseMs: 18,
      sigma: 0.35,
      replicas: DEFAULT_REPLICAS,
      capacityPerReplica: 250,
      leakBytesPerReq: 0,
      heapLimitBytes: HEAP_LIMIT,
    },
  },
  "payment-service": {
    baseRps: 320,
    dependencies: [],
    config: {
      dbPoolMax: 40,
      dbHoldMs: 25,
      dbFraction: 0.15,
      baseMs: 22,
      sigma: 0.4,
      replicas: DEFAULT_REPLICAS,
      capacityPerReplica: 220,
      leakBytesPerReq: 0,
      heapLimitBytes: HEAP_LIMIT,
    },
  },
  "inventory-service": {
    baseRps: 320,
    dependencies: [],
    config: {
      dbPoolMax: 40,
      dbHoldMs: 20,
      dbFraction: 0.2,
      baseMs: 12,
      sigma: 0.3,
      replicas: DEFAULT_REPLICAS,
      capacityPerReplica: 220,
      leakBytesPerReq: 0,
      heapLimitBytes: HEAP_LIMIT,
    },
  },
  "user-service": {
    baseRps: 130,
    dependencies: [],
    config: {
      dbPoolMax: 40,
      dbHoldMs: 30,
      dbFraction: 0.35,
      baseMs: 14,
      sigma: 0.32,
      replicas: DEFAULT_REPLICAS,
      capacityPerReplica: 200,
      leakBytesPerReq: 0,
      heapLimitBytes: HEAP_LIMIT,
    },
  },
};

/**
 * A configuration change in flight.
 *
 * Config changes ramp rather than snapping, because a rollback in production is a
 * rolling restart: capacity comes back progressively. This is what makes FR-9.1 true
 * by construction — no action can produce instant recovery, because no action changes
 * a value instantly.
 */
export interface Transition {
  service: ServiceName;
  field: keyof ServiceConfig;
  from: number;
  to: number;
  startMs: number;
  durationMs: number;
}

export interface World {
  seed: number;
  /** Simulated ms since T0. Advanced only by tick(). */
  nowMs: number;
  tick: number;
  rng: Rng;
  services: Record<ServiceName, ServiceState>;
  transitions: Transition[];
  deployments: Deployment[];
  flags: FeatureFlag[];
  incident: Incident | null;
  /** Consecutive simulated seconds each service has spent breaching incident thresholds. */
  breachSec: Record<ServiceName, number>;
  /** Consecutive simulated seconds each service has spent inside recovery thresholds. */
  recoverySec: Record<ServiceName, number>;
  /** Actions applied to the environment, oldest first — FR-10.1a. */
  actions: AppliedAction[];
  /** Monotonic id counters. Never random — FR-1.5. */
  counters: Record<string, number>;
}

export function createWorld(seed: number): World {
  const services = {} as Record<ServiceName, ServiceState>;
  const breachSec = {} as Record<ServiceName, number>;
  const recoverySec = {} as Record<ServiceName, number>;

  for (const name of SERVICE_NAMES) {
    breachSec[name] = 0;
    recoverySec[name] = 0;
    const def = SERVICE_DEFS[name];
    services[name] = {
      name,
      config: { ...def.config },
      dependencies: [...def.dependencies],
      inboundRps: def.baseRps,
      heapBytes: 0,
      waiters: 0,
      connectionsInUse: 0,
      trafficShiftedAway: 0,
      startedAtMs: 0,
    };
  }

  return {
    seed,
    nowMs: 0,
    tick: 0,
    rng: createRng(seed),
    services,
    transitions: [],
    deployments: [],
    flags: [],
    incident: null,
    breachSec,
    recoverySec,
    actions: [],
    counters: {},
  };
}

/** Baseline inbound rate for a service, before any traffic shifting. */
export function baseRpsFor(name: ServiceName): number {
  return SERVICE_DEFS[name].baseRps;
}

export function nextId(world: World, prefix: string): string {
  const n = (world.counters[prefix] ?? 0) + 1;
  world.counters[prefix] = n;
  return `${prefix}_${String(n).padStart(4, "0")}`;
}

/**
 * Schedule a configuration change that ramps in over `durationMs`.
 * Passing 0 applies it on the next tick, which is what a process restart does.
 */
export function scheduleConfigChange(
  world: World,
  service: ServiceName,
  field: keyof ServiceConfig,
  to: number,
  durationMs: number = ROLLOUT_MS,
): void {
  const from = world.services[service].config[field];
  if (from === to) return;

  // A newer change to the same field supersedes anything still in flight.
  world.transitions = world.transitions.filter(
    (t) => !(t.service === service && t.field === field),
  );

  world.transitions.push({
    service,
    field,
    from,
    to,
    startMs: world.nowMs,
    durationMs,
  });
}

/** Advance every in-flight transition to `world.nowMs`, writing interpolated values. */
export function applyTransitions(world: World): void {
  if (world.transitions.length === 0) return;

  const stillRunning: Transition[] = [];

  for (const t of world.transitions) {
    const elapsed = world.nowMs - t.startMs;
    const progress = t.durationMs <= 0 ? 1 : Math.min(1, elapsed / t.durationMs);
    world.services[t.service].config[t.field] = t.from + (t.to - t.from) * progress;
    if (progress < 1) stillRunning.push(t);
  }

  world.transitions = stillRunning;
}
