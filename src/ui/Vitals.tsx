import type { MetricPoint } from "../engine";
import { millis, pct, rate } from "./format";

/**
 * The FR-4.1 signals the charts do not draw.
 *
 * FR-12.3 requires every FR-4 evidence source to be browsable with no agent present,
 * and metrics are a *source*, not a chart: request rate, p50, p95, CPU, memory and
 * replica count are all named in FR-4.1, and until now every one of them was reachable
 * only through `get_metrics`. A human reading the dashboard could not see the traffic
 * the environment was serving — which is the first thing anyone checks, because steady
 * throughput under a rising error rate rules out a traffic surge as the cause.
 */
export function Vitals({ point }: { point: MetricPoint | null }) {
  if (!point) return null;

  const signals: Array<[label: string, value: string]> = [
    ["Rate", rate(point.requests)],
    ["p50", millis(point.p50)],
    ["p95", millis(point.p95)],
    ["CPU", pct(point.cpu, 0)],
    ["Memory", pct(point.memory, 0)],
    ["Replicas", String(point.replicas)],
  ];

  return (
    <dl className="vitals">
      {signals.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
