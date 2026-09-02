import type { MetricPoint } from "../engine";

/**
 * Hand-rolled SVG time series. No charting dependency — the shapes needed here are a
 * line, a fill and a few threshold rules, and a library would cost more than it saves.
 *
 * `vector-effect: non-scaling-stroke` lets the viewBox stretch to any panel width
 * while keeping strokes exactly one pixel, so the chart stays crisp without measuring
 * the container.
 */

const W = 640;
const H = 128;

export interface ChartThreshold {
  value: number;
  label: string;
}

export function MetricChart({
  points,
  field,
  title,
  format,
  thresholds = [],
  windowSec = 240,
  floor = 0,
}: {
  points: MetricPoint[];
  field: "errorRate" | "p99" | "p50" | "requests";
  title: string;
  format: (v: number) => string;
  thresholds?: ChartThreshold[];
  windowSec?: number;
  /** Minimum for the y-axis, so a flat healthy line is not magnified into noise. */
  floor?: number;
}) {
  const data = points.slice(-windowSec);
  const values = data.map((p) => p[field]);
  const latest = values.length > 0 ? values[values.length - 1]! : 0;

  // Scale to the signal, not to the thresholds. Pinning the axis to a 3s SEV-2 line
  // would flatten a healthy 104ms trace into a dead line along the bottom; a threshold
  // joins the scale only once the data is within reach of it, which is exactly when it
  // becomes worth looking at.
  const dataMax = Math.max(floor, ...values);
  const relevant = thresholds.filter((t) => t.value <= dataMax * 1.6);
  const ceiling = Math.max(dataMax, ...relevant.map((t) => t.value)) * 1.25 || 1;
  const x = (i: number) => (data.length <= 1 ? 0 : (i / (data.length - 1)) * W);
  const y = (v: number) => H - (v / ceiling) * H;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `${line.join(" ")} L${W},${H} L0,${H} Z`;

  const breachLine = thresholds[0];
  const breached = breachLine ? latest > breachLine.value : false;

  return (
    <figure className={`chart ${breached ? "is-breached" : ""}`}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-value">{format(latest)}</span>
      </figcaption>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}, currently ${format(latest)}`}
      >
        {relevant.map((t) => (
          <line
            key={t.label}
            className="chart-threshold"
            x1={0}
            x2={W}
            y1={y(t.value)}
            y2={y(t.value)}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {data.length > 1 && (
          <>
            <path className="chart-area" d={area} />
            <path className="chart-line" d={line.join(" ")} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      <div className="chart-axis">
        {relevant.map((t) => (
          <span key={t.label} className="chart-axis-label">
            {t.label} {format(t.value)}
          </span>
        ))}
        <span className="chart-window">last {Math.min(windowSec, data.length)}s</span>
      </div>
    </figure>
  );
}
