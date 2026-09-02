import { useState } from "react";
import type { Engine, Runbook, ServiceName, Span, Trace } from "../engine";
import { millis, relativeAge, shortClock } from "./format";

/**
 * The five evidence sources a human correlates.
 *
 * Each tab shows record ids, because an id is what makes a finding citable rather
 * than a recollection (FR-6.1). The same ids are what the agent's tools return, so a
 * human and an agent can talk about the same record.
 *
 * Runbooks and ownership are here because FR-12.3 requires *all* FR-4 evidence to be
 * browsable with no agent present. They existed in the engine and in the tool layer
 * before they existed on screen, which meant the agent could read two sources the human
 * could not — precisely the asymmetry FR-12 exists to forbid.
 */

type Tab = "logs" | "traces" | "deployments" | "runbooks" | "ownership";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "logs", label: "Logs" },
  { id: "traces", label: "Traces" },
  { id: "deployments", label: "Deployments" },
  { id: "runbooks", label: "Runbooks" },
  { id: "ownership", label: "Ownership" },
];

function Waterfall({ span, rootDuration, depth = 0 }: { span: Span; rootDuration: number; depth?: number }) {
  const width = rootDuration > 0 ? (span.durationMs / rootDuration) * 100 : 0;
  const offset = rootDuration > 0 ? (span.startMs / rootDuration) * 100 : 0;

  return (
    <>
      <div className="span-row" style={{ paddingLeft: `${depth * 14}px` }}>
        <span className={`span-name ${span.error ? "is-error" : ""}`}>{span.name}</span>
        <span className="span-track">
          <span
            className={`span-bar ${span.error ? "is-error" : ""}`}
            style={{ left: `${offset}%`, width: `${Math.max(width, 0.6)}%` }}
          />
        </span>
        <span className="span-duration">{millis(span.durationMs)}</span>
      </div>
      {span.children.map((child, i) => (
        <Waterfall key={`${child.name}-${i}`} span={child} rootDuration={rootDuration} depth={depth + 1} />
      ))}
    </>
  );
}

function TraceList({ traces }: { traces: Trace[] }) {
  const [open, setOpen] = useState<string | null>(null);

  if (traces.length === 0) return <p className="empty">No traces captured for this service yet.</p>;

  return (
    <ul className="records">
      {traces.map((trace) => (
        <li key={trace.id}>
          <button
            type="button"
            className={`record trace ${trace.status === "error" ? "is-error" : ""}`}
            onClick={() => setOpen(open === trace.id ? null : trace.id)}
            aria-expanded={open === trace.id}
          >
            <span className="record-id">{trace.id}</span>
            <span className="record-time">{shortClock(trace.t)}</span>
            <span className="record-main">{trace.root.name}</span>
            <span className={`record-tail ${trace.status === "error" ? "is-error" : ""}`}>
              {millis(trace.durationMs)}
            </span>
          </button>

          {open === trace.id && (
            <div className="waterfall">
              <Waterfall span={trace.root} rootDuration={trace.root.durationMs} />
              {trace.root.error && <p className="span-error">{trace.root.error}</p>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function RunbookList({ runbooks }: { runbooks: Runbook[] }) {
  const [open, setOpen] = useState<string | null>(null);

  if (runbooks.length === 0) {
    return <p className="empty">No runbook matches that search. Clear it to see the whole library.</p>;
  }

  return (
    <ul className="records">
      {runbooks.map((runbook) => (
        <li key={runbook.id}>
          <button
            type="button"
            className="record runbook"
            onClick={() => setOpen(open === runbook.id ? null : runbook.id)}
            aria-expanded={open === runbook.id}
          >
            <span className="record-id">{runbook.id}</span>
            <span className="record-main">
              <strong>{runbook.title}</strong>
            </span>
            <span className="record-tail">
              {runbook.appliesTo === "any" ? "any service" : runbook.appliesTo.join(", ")}
            </span>
          </button>

          {open === runbook.id && (
            <div className="runbook-body">
              <ol className="runbook-steps">
                {runbook.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <p className="runbook-signals">
                Signals to pull: <span>{runbook.signals.join(", ")}</span>
              </p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function EvidenceTabs({ engine, service }: { engine: Engine; service: ServiceName }) {
  const [tab, setTab] = useState<Tab>("logs");
  const [query, setQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);

  const logs = engine.store.logs
    .filter((entry) => entry.service === service)
    .filter((entry) => (errorsOnly ? entry.level === "error" || entry.level === "warn" : true))
    .filter((entry) => (query ? entry.message.toLowerCase().includes(query.toLowerCase()) : true))
    .slice(-60)
    .reverse();

  const traces = engine.store.traces
    .filter((t) => t.service === service)
    .filter((t) => (errorsOnly ? t.status === "error" : true))
    .slice(-40)
    .reverse();

  const deployments = engine.world.deployments
    .filter((d) => d.service === service)
    .sort((a, b) => b.t - a.t);

  /*
   * The whole library, not only what applies to the selected service. An on-call engineer
   * browsing runbooks is deciding *which* failure mode they are looking at, and a list
   * pre-filtered to the service they happen to have highlighted would answer that question
   * for them.
   */
  const runbooks = engine.runbooks(query || undefined);
  const owner = engine.ownership(service);

  return (
    <section className="evidence">
      <header className="evidence-head">
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <span className="evidence-spacer" />

        {(tab === "logs" || tab === "traces") && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
            />
            Problems only
          </label>
        )}

        {(tab === "logs" || tab === "runbooks") && (
          <input
            className="search"
            type="search"
            value={query}
            placeholder={tab === "logs" ? "Filter messages" : "Search by symptom"}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </header>

      <div className="evidence-body">
        {tab === "logs" &&
          (logs.length === 0 ? (
            <p className="empty">No log lines match. Clear the filters to see everything.</p>
          ) : (
            <ul className="records">
              {logs.map((entry) => (
                <li key={entry.id}>
                  <div className="record log">
                    <span className="record-id">{entry.id}</span>
                    <span className="record-time">{shortClock(entry.t)}</span>
                    <span className={`level is-${entry.level}`}>{entry.level}</span>
                    <span className="record-main">{entry.message}</span>
                  </div>
                </li>
              ))}
            </ul>
          ))}

        {tab === "traces" && <TraceList traces={traces} />}

        {tab === "deployments" &&
          (deployments.length === 0 ? (
            <p className="empty">No deployments recorded for {service}.</p>
          ) : (
            <ul className="records">
              {deployments.map((d) => (
                <li key={d.id}>
                  <div className={`record deploy ${d.rolledBack ? "is-rolled-back" : ""}`}>
                    <span className="record-id">{d.id}</span>
                    <span className="record-time">{relativeAge(d.t, engine.world.nowMs)}</span>
                    <span className="record-main">
                      <strong>{d.version}</strong> {d.summary}
                      <em className="deploy-author">{d.author}</em>
                      {d.rolledBack && <span className="rolled-back">rolled back</span>}
                    </span>
                  </div>
                  <div className="diff">
                    {d.diff.map((change) => (
                      <div key={change.key} className="diff-row">
                        <span className="diff-key">{change.key}</span>
                        <span className="diff-from">{change.from}</span>
                        <span className="diff-arrow">→</span>
                        <span className="diff-to">{change.to}</span>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ))}

        {tab === "runbooks" && <RunbookList runbooks={runbooks} />}

        {tab === "ownership" && (
          <div className="ownership">
            <div className="record own">
              <span className="record-id">{owner.id}</span>
              <span className="record-main">
                <strong>{owner.team}</strong> owns {owner.service}
              </span>
            </div>
            <dl className="own-detail">
              <dt>On call</dt>
              <dd>{owner.onCall}</dd>
              <dt>Escalation</dt>
              <dd>{owner.escalation}</dd>
              <dt>Channel</dt>
              <dd>{owner.channel}</dd>
              <dt>Paging policy</dt>
              <dd>{owner.policy}</dd>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
