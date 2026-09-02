import type { Incident, MetricPoint } from "../engine";
import {
  INCIDENT_ERROR_RATE_THRESHOLD,
  INCIDENT_P99_THRESHOLD_MS,
  INCIDENT_SUSTAIN_SEC,
  SEV1_ERROR_RATE,
  SEV2_ERROR_RATE,
  SEV2_P99_MS,
} from "../engine/constants";
import { millis, pct, shortClock } from "./format";

/**
 * The alarm rail.
 *
 * Status banners normally assert a severity and leave you to trust it. This one shows
 * its arithmetic: each golden signal is drawn against the thresholds that classify it,
 * so a reader can see the measured value sitting past a labelled line rather than
 * taking "SEV-2" on faith. That is the product's own principle — evidence over
 * assertion — expressed as the first thing on the screen.
 */

interface Tick {
  at: number;
  /** What crossing this line means. Kept short — it sits under a 1px rule. */
  name: string;
  /** The threshold itself, so the reader can check the arithmetic. */
  reading: string;
}

function Meter({
  label,
  value,
  max,
  ticks,
  format,
  breached,
}: {
  label: string;
  value: number;
  max: number;
  ticks: Tick[];
  format: (v: number) => string;
  breached: boolean;
}) {
  const fill = Math.max(0, Math.min(1, value / max));

  return (
    <div className="meter">
      <span className="meter-label">{label}</span>

      <div className="meter-track">
        <div
          className={`meter-fill ${breached ? "is-breached" : "is-clear"}`}
          style={{ width: `${fill * 100}%` }}
        />
        {ticks.map((tick) => (
          <div key={tick.name} className="meter-tick" style={{ left: `${(tick.at / max) * 100}%` }}>
            <span className="meter-tick-label">
              <b>{tick.reading}</b>
              <i>{tick.name}</i>
            </span>
          </div>
        ))}
      </div>

      <span className={`meter-value ${breached ? "is-breached" : ""}`}>{format(value)}</span>
    </div>
  );
}

export function AlarmRail({
  incident,
  point,
  serviceLabel,
}: {
  incident: Incident | null;
  point: MetricPoint | null;
  serviceLabel: string;
}) {
  const errorRate = point?.errorRate ?? 0;
  const p99 = point?.p99 ?? 0;

  const severity = incident?.severity ?? null;
  const closed = incident?.status === "resolved";

  // A resolved incident keeps its severity — that is a fact of the record — but stands
  // the alarm down. Leaving the rail red after recovery would train the reader to stop
  // believing it, which is the one thing an alarm cannot afford.
  const tone = closed || !severity ? "clear" : severity === "SEV-1" ? "sev1" : "sev2";

  return (
    <section className={`rail rail-${tone}`} aria-live="polite">
      <div className="rail-head">
        {incident ? (
          <>
            <span className={`sev-chip ${closed ? "is-closed" : ""}`}>{incident.severity}</span>
            <h2 className="rail-title">{incident.title}</h2>
            <span className={`rail-status ${closed ? "is-closed" : ""}`}>{incident.status}</span>
            <span className="rail-spacer" />
            <span className="rail-meta">
              {incident.id} · opened {shortClock(incident.openedAt)} · thresholds held{" "}
              {INCIDENT_SUSTAIN_SEC}s
            </span>
          </>
        ) : (
          <>
            <span className="sev-chip is-clear">CLEAR</span>
            <h2 className="rail-title">No incident. {serviceLabel} is serving normally.</h2>
            <span className="rail-spacer" />
            <span className="rail-meta">
              Watching error rate and p99 against the thresholds below
            </span>
          </>
        )}
      </div>

      <div className="rail-meters">
        <Meter
          label="error rate"
          value={errorRate}
          max={0.3}
          breached={errorRate > INCIDENT_ERROR_RATE_THRESHOLD}
          format={(v) => pct(v, 2)}
          ticks={[
            { at: INCIDENT_ERROR_RATE_THRESHOLD, name: "opens", reading: "2%" },
            { at: SEV2_ERROR_RATE, name: "SEV-2", reading: "5%" },
            { at: SEV1_ERROR_RATE, name: "SEV-1", reading: "25%" },
          ]}
        />
        <Meter
          label="latency p99"
          value={p99}
          max={4000}
          breached={p99 > INCIDENT_P99_THRESHOLD_MS}
          format={millis}
          ticks={[
            { at: INCIDENT_P99_THRESHOLD_MS, name: "opens", reading: "1s" },
            { at: SEV2_P99_MS, name: "SEV-2", reading: "3s" },
          ]}
        />
      </div>
    </section>
  );
}
