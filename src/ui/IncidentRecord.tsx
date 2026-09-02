import { SERVICE_NAMES, type Engine, type ServiceName } from "../engine";
import type { AuditEntry } from "./useSimulation";
import { shortClock } from "./format";

/**
 * The record column: what the incident is, what has been done to it, and the controls
 * to do more.
 *
 * Every control here is available to a human with no agent present (FR-12), and runs
 * the same engine operation the agent's tools will call in P4 — not a parallel
 * implementation (FR-12.2). Human actions need no approval, because the human is
 * already the approver (FR-12.5).
 */

/** `detected` is omitted: the detector assigns it, so it is never a human's move. */
type ChosenStatus = "investigating" | "identified" | "mitigating" | "resolved";

const NEXT_STATUS: ChosenStatus[] = ["investigating", "identified", "mitigating", "resolved"];

export function IncidentRecord({
  engine,
  audit,
  service,
  onRollback,
  onStatus,
}: {
  engine: Engine;
  audit: readonly AuditEntry[];
  service: ServiceName;
  onRollback(service: ServiceName): void;
  onStatus(status: ChosenStatus): void;
}) {
  const incident = engine.incident;
  const rollbackTarget = engine.world.deployments
    .filter((d) => d.service === service && !d.rolledBack)
    .sort((a, b) => b.t - a.t)[0];

  return (
    <div className="record-column">
      <section className="block">
        <h3 className="block-head">Incident</h3>

        {incident ? (
          <>
            <dl className="facts">
              <div>
                <dt>id</dt>
                <dd>{incident.id}</dd>
              </div>
              <div>
                <dt>severity</dt>
                <dd>{incident.severity}</dd>
              </div>
              <div>
                <dt>status</dt>
                <dd>{incident.status}</dd>
              </div>
              <div>
                <dt>affected</dt>
                <dd>{incident.affectedServices.join(", ")}</dd>
              </div>
            </dl>

            <div className="status-row">
              {NEXT_STATUS.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={`chip ${incident.status === status ? "is-current" : ""}`}
                  disabled={incident.status === status || incident.status === "resolved"}
                  onClick={() => onStatus(status)}
                >
                  {status}
                </button>
              ))}
            </div>

            {incident.recoveryVerifiedAt === null && (
              <p className="note">
                Resolution unlocks once error rate and p99 hold inside the recovery thresholds for
                30 seconds.
              </p>
            )}
          </>
        ) : (
          <p className="empty">
            No incident open. One is raised automatically when a service breaches the thresholds on
            the rail above.
          </p>
        )}
      </section>

      <section className="block">
        <h3 className="block-head">Act</h3>

        <p className="action-target">
          Target <strong>{service}</strong> — selected in the environment list.
        </p>

        <button
          type="button"
          className="action"
          disabled={!rollbackTarget}
          onClick={() => onRollback(service)}
        >
          <span className="action-name">Roll back deployment</span>
          <span className="blast is-high">HIGH blast radius</span>
          <span className="action-detail">
            {rollbackTarget
              ? `${rollbackTarget.version} → ${rollbackTarget.previousVersion} · ${rollbackTarget.summary}`
              : "Nothing left to roll back on this service"}
          </span>
        </button>

        <p className="note">
          Restart, scale, feature flag and traffic shift arrive with the mechanisms they act on.
        </p>
      </section>

      <section className="block block-grow">
        <h3 className="block-head">Timeline</h3>

        {incident && incident.timeline.length > 0 ? (
          <ol className="timeline">
            {incident.timeline
              .slice()
              .reverse()
              .map((entry, i) => (
                <li key={`${entry.t}-${i}`} className={`event is-${entry.actor}`}>
                  <span className="event-time">{shortClock(entry.t)}</span>
                  <span className="event-actor">{entry.actor}</span>
                  <span className="event-message">{entry.message}</span>
                </li>
              ))}
          </ol>
        ) : (
          <p className="empty">Nothing recorded yet.</p>
        )}
      </section>

      <section className="block">
        <h3 className="block-head">
          Activity
          <span className="block-note">{audit.length} operations</span>
        </h3>

        {audit.length > 0 ? (
          <ol className="timeline">
            {audit
              .slice()
              .reverse()
              .map((entry) => (
                <li
                  key={entry.id}
                  className={`event is-${entry.source === "webmcp" ? "agent" : "human"} ${
                    entry.status === "ok" ? "" : "is-refused"
                  }`}
                >
                  <span className="event-time">{shortClock(entry.timestamp)}</span>
                  <span className="event-actor">{entry.source}</span>
                  <span className="event-message">
                    <strong>{entry.operation}</strong> {entry.arguments} — {entry.result_summary}
                  </span>
                </li>
              ))}
          </ol>
        ) : (
          <p className="empty">
            Actions you take here are recorded as <code>ui_action</code>, separately from anything
            an agent calls.
          </p>
        )}
      </section>
    </div>
  );
}

export { SERVICE_NAMES };
