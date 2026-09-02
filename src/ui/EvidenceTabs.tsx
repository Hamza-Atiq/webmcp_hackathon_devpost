import { useState } from "react";
import type { Engine, ServiceName, Span, Trace } from "../engine";
import { millis, relativeAge, shortClock } from "./format";

/**
 * Logs, traces and deployments — the three evidence sources a human correlates.
 *
 * Each tab shows record ids, because an id is what makes a finding citable rather
 * than a recollection (FR-6.1). The same ids are what the agent's tools return, so a
 * human and an agent can talk about the same record.
 */

type Tab = "logs" | "traces" | "deployments";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "logs", label: "Logs" },
  { id: "traces", label: "Traces" },
  { id: "deployments", label: "Deployments" },
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

        {tab !== "deployments" && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
            />
            Problems only
          </label>
        )}

        {tab === "logs" && (
          <input
            className="search"
            type="search"
            value={query}
            placeholder="Filter messages"
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
      </div>
    </section>
  );
}
