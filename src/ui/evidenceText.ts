import type { Engine } from "../engine";
import type { EvidenceRegistry } from "../mcp/evidence";
import { shortClock } from "./format";

/**
 * Turns an evidence id into something a person can judge — FR-7.6.
 *
 * A proposal card listing `log_0350, dep_0006` asks a human to approve a change to
 * production on the strength of two strings. The point of showing cited evidence is that
 * the approver can check the agent's reasoning against the same records the agent read,
 * so each id is resolved back to the record it names.
 *
 * Metric series are the one kind with no record to look up: the id is minted per response
 * (spec 003 §5). For those the registry's memory of the call that produced it — the tool
 * and its arguments — is what makes the citation legible.
 */
export function describeEvidence(engine: Engine, registry: EvidenceRegistry, id: string): string {
  const prefix = id.slice(0, id.indexOf("_"));

  switch (prefix) {
    case "log": {
      const entry = engine.store.logs.find((l) => l.id === id);
      return entry
        ? `${shortClock(entry.t)} ${entry.service} [${entry.level}] ${entry.message}`
        : "log line, no longer retained";
    }
    case "trc": {
      const trace = engine.store.traces.find((t) => t.id === id);
      return trace
        ? `${shortClock(trace.t)} ${trace.service} trace, ${Math.round(trace.durationMs)}ms, ${trace.status}`
        : "trace, no longer retained";
    }
    case "dep": {
      const deployment = engine.world.deployments.find((d) => d.id === id);
      return deployment
        ? `${deployment.service} ${deployment.previousVersion} → ${deployment.version} by ${deployment.author} — ${deployment.summary}`
        : "deployment";
    }
    case "rb": {
      const runbook = engine.runbook(id);
      return runbook ? `runbook: ${runbook.title}` : "runbook";
    }
    case "own": {
      const service = id.slice(4);
      const owner = engine.world.services[service as never]
        ? engine.ownership(service as never)
        : undefined;
      return owner ? `ownership: ${owner.team}, on call ${owner.onCall}` : "ownership record";
    }
    case "inc":
      return engine.incident ? `incident ${engine.incident.severity}: ${engine.incident.title}` : "incident record";
    case "svc":
      return `service inventory: ${id.slice(4)}`;
    case "met": {
      const entry = registry.entry(id);
      return entry ? `${entry.tool} ${entry.args ?? ""}`.trim() : "metric series";
    }
    default:
      return id;
  }
}
