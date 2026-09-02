/**
 * Seeded pseudo-random number generator.
 *
 * The entire simulation is reproducible from a seed (FR-1.5, AC-12), so this is the
 * only source of randomness in the engine — `Math.random` is banned outright and the
 * determinism guard test enforces it.
 *
 * mulberry32: 32-bit state, good distribution, extremely fast. Speed matters here
 * because at 60x the engine draws on the order of 20k samples per real second.
 *
 * The critical discipline is not the algorithm but *who is allowed to draw*: only
 * `tick()` may advance a generator, in a fixed order. A tool call or a UI render that
 * consumed a draw would make the run depend on observation, and replay would diverge.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Standard normal, via Box-Muller. */
  normal(): number;
  /**
   * Lognormal draw with the given median and shape. Latency is lognormal in
   * practice — a tight body with a long right tail — which is what produces a
   * realistic gap between p50 and p99 without special-casing the tail.
   */
  lognormal(median: number, sigma: number): number;
  /** Exponential draw with the given mean. */
  exponential(mean: number): number;
  /** Current internal state, for snapshotting. */
  state(): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;

  // Box-Muller produces two normals per pair of draws; cache the spare so the
  // number of underlying draws stays deterministic and halved.
  let spare: number | null = null;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    // Guard against log(0).
    let u = next();
    while (u === 0) u = next();
    const v = next();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };

  return {
    next,
    normal,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    lognormal: (median, sigma) => median * Math.exp(sigma * normal()),
    exponential: (mean) => {
      let u = next();
      while (u === 0) u = next();
      return -mean * Math.log(u);
    },
    state: () => s,
  };
}
