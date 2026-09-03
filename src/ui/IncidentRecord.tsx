import {
  ACTION_KINDS,
  BLAST_RADIUS,
  MAX_REPLICAS,
  flagByKey,
  type ActionKind,
  type Engine,
  type RemediationParams,
  type ServiceName,
} from "../engine";
import { SERVICE_NAMES } from "../engine";
import type { AuditEntry } from "./useSimulation";
import type { Proposal } from "../mcp/proposals";
import { useState } from "react";
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

/**
 * What a human control does, in the words shown on it.
 *
 * The five are the same five an agent can propose (FR-12.1), with the same parameters,
 * and they run the same engine operation (FR-12.2). A human needs no approval for them,
 * because the person clicking is already the approver (FR-12.5).
 */
const ACTION_LABELS: Record<ActionKind, string> = {
  rollback_deployment: "Roll back deployment",
  restart_service: "Restart service",
  scale_replicas: "Scale replicas",
  disable_feature_flag: "Disable feature flag",
  shift_traffic: "Shift traffic away",
};

export function IncidentRecord({
  engine,
  audit,
  service,
  proposals,
  postmortem,
  onPostmortem,
  onRemediate,
  onStatus,
}: {
  engine: Engine;
  audit: readonly AuditEntry[];
  service: ServiceName;
  proposals: readonly Proposal[];
  postmortem: string | null;
  onPostmortem(): void;
  onRemediate(kind: ActionKind, service: ServiceName, params?: RemediationParams): void;
  onStatus(status: ChosenStatus): void;
}) {
  const [copied, setCopied] = useState(false);
  /*
   * Enabled flags on the selected service. A flag already switched off is not an action
   * anyone can take, and offering it would be offering a no-op.
   */
  const flags = engine.world.flags.filter((f) => f.service === service && f.enabled);
  const [chosen, setFlag] = useState<string>("");
  const flag = flags.some((f) => f.key === chosen) ? chosen : (flags[0]?.key ?? "");
  const incident = engine.incident;

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

        {ACTION_KINDS.map((kind) => (
          <div key={kind} className="action-row">
            <button
              type="button"
              className="action"
              onClick={() =>
                onRemediate(kind, service, {
                  ...defaultParams(engine, kind, service),
                  ...(kind === "disable_feature_flag" ? { flag } : {}),
                })
              }
            >
              <span className="action-name">{ACTION_LABELS[kind]}</span>
              <span className={`blast is-${BLAST_RADIUS[kind].toLowerCase()}`}>
                {BLAST_RADIUS[kind]} blast radius
              </span>
              <span className="action-detail">
                {kind === "disable_feature_flag"
                  ? (flags.find((f) => f.key === flag)?.description ?? "No flag is enabled here")
                  : actionDetail(engine, kind, service)}
              </span>
            </button>

            {/*
              FR-12.1 — a human has every action the agent has, *with the same parameters*.
              Without this the control could only ever disable whichever flag happened to
              be listed first, so a person working scenario 3 or 4 by hand could not reach
              the flag that is actually the fix. The agent chooses a flag by name; so does
              a human, from the same list.
            */}
            {kind === "disable_feature_flag" && flags.length > 0 && (
              <label className="action-param">
                <span>Flag</span>
                <select value={flag} onChange={(event) => setFlag(event.target.value)}>
                  {flags.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.key}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ))}

        <p className="note">
          Your actions apply immediately and are not gated — you are the approver. An agent
          proposing any of these has to wait for your click.
        </p>
      </section>

      <section className="block">
        <h3 className="block-head">
          Proposals
          <span className="block-note">{proposals.length} from the agent</span>
        </h3>

        {proposals.length > 0 ? (
          <ol className="proposals">
            {proposals
              .slice()
              .reverse()
              .map((proposal) => (
                <li key={proposal.id} className={`proposal is-${proposal.status}`}>
                  <span className="proposal-id">{proposal.id}</span>
                  <span className="proposal-status">{proposal.status.replace(/_/g, " ")}</span>
                  <span className="proposal-main">
                    <strong>{ACTION_LABELS[proposal.action]}</strong> on {proposal.service}
                    <em className="proposal-why">{proposal.hypothesis}</em>
                    {proposal.decisionReason && (
                      <em className="proposal-why">Your reason: {proposal.decisionReason}</em>
                    )}
                  </span>
                </li>
              ))}
          </ol>
        ) : (
          <p className="empty">
            Nothing proposed. An agent must cite two independent pieces of evidence before it can
            propose anything at all.
          </p>
        )}
      </section>

      {/*
        FR-11.4 — the postmortem is displayed and can be copied. FR-12.4 — a human can
        write one with no agent involved, and it is the same document from the same
        assembler, not a second implementation that will drift.
      */}
      <section className="block">
        <h3 className="block-head">
          Postmortem
          <span className="block-note">{postmortem ? "written" : "not written"}</span>
        </h3>

        <div className="postmortem-controls">
          <button type="button" className="ghost" onClick={onPostmortem}>
            {postmortem ? "Rewrite from the record" : "Write postmortem"}
          </button>
          {postmortem && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(postmortem).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>

        {postmortem ? (
          <pre className="postmortem">{postmortem}</pre>
        ) : (
          <p className="empty">
            Assembled from the incident record, the evidence retrieved and the actions applied. The
            root cause it records is the diagnosis a human approved, attributed to whoever wrote it —
            never a finding of the system.
          </p>
        )}
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

/** Sensible defaults, so a human control is one click rather than a form. */
function defaultParams(engine: Engine, kind: ActionKind, service: ServiceName): RemediationParams {
  switch (kind) {
    case "scale_replicas":
      return {
        replicas: Math.min(MAX_REPLICAS, Math.round(engine.world.services[service].config.replicas) + 3),
      };
    case "disable_feature_flag":
      return { flag: engine.world.flags.find((f) => f.service === service && f.enabled)?.key };
    case "shift_traffic":
      return { fraction: 0.5 };
    default:
      return {};
  }
}

/** What this control would actually do to this service, right now. */
function actionDetail(engine: Engine, kind: ActionKind, service: ServiceName): string {
  const state = engine.world.services[service];

  switch (kind) {
    case "rollback_deployment": {
      const target = engine.world.deployments
        .filter((d) => d.service === service && !d.rolledBack)
        .sort((a, b) => b.t - a.t)[0];
      return target
        ? `${target.version} → ${target.previousVersion} · ${target.summary}`
        : "No deployment left to roll back on this service";
    }
    case "restart_service":
      return "Clears process state; in-flight requests fail while replicas cycle";
    case "scale_replicas": {
      const now = Math.round(state.config.replicas);
      return `${now} → ${Math.min(MAX_REPLICAS, now + 3)} replicas`;
    }
    case "disable_feature_flag": {
      const flag = engine.world.flags.find((f) => f.service === service && f.enabled);
      return flag ? `${flag.key} · ${flag.description}` : "No enabled flag on this service";
    }
    case "shift_traffic":
      return "Routes half this service's traffic elsewhere; the database it shares sees the same load";
  }
}

export { SERVICE_NAMES, flagByKey };
