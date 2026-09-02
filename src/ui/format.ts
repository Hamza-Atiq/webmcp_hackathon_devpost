import type { MetricPoint } from "../engine";

/** Presentation helpers. Every number on screen goes through one of these. */

/** Simulated clock as T+HH:MM:SS — the only time notation in the interface. */
export function simClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `T+${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Short form for dense rows: T+04:21, dropping hours until they exist. */
export function shortClock(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = ms < 0 ? "−" : "+";
  return h > 0 ? `T${sign}${h}:${pad(m)}:${pad(s)}` : `T${sign}${pad(m)}:${pad(s)}`;
}

/** Deployment ages are quoted in hours, the way a deploy list actually reads. */
export function relativeAge(t: number, nowMs: number): string {
  const deltaSec = Math.round((nowMs - t) / 1000);
  if (deltaSec < 90) return `${deltaSec}s ago`;
  const min = Math.round(deltaSec / 60);
  if (min < 90) return `${min}m ago`;
  return `${(min / 60).toFixed(1)}h ago`;
}

export function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function millis(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

export function bytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(0)} MB`;
}

/** Mean of a field over the last `seconds` of points, or null when there is no data. */
export function meanOfLast(
  points: MetricPoint[],
  field: "errorRate" | "p99" | "p50",
  seconds: number,
): number | null {
  const slice = points.slice(-seconds);
  if (slice.length === 0) return null;
  return slice.reduce((sum, p) => sum + p[field], 0) / slice.length;
}
