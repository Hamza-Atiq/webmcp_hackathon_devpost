import type { Engine } from "../engine";
import { verifyRemediation } from "./tools/readonly";
import type { Session } from "../session";
import type { Proposal } from "./proposals";

/**
 * The postmortem — FR-11.2, FR-11.3, and one rule that matters more than the format.
 *
 * **The system never states a root cause of its own.** It records the hypothesis a human
 * approved, attributed to whoever wrote it, and labels it as a claim. Asserting the real
 * mechanism would disclose the scenario (FR-2.5) and would also be a lie about how the
 * incident was actually understood: what closed it was somebody's diagnosis, right or
 * wrong. A postmortem here can therefore record a wrong diagnosis, and that is correct
 * behaviour rather than a defect — a postmortem that could not be wrong would be a
 * transcript of the simulation, not a record of an investigation (FR-11.2a).
 *
 * Every line is assembled from the incident record, the evidence registry and the audit
 * trail. Nothing is narrated (FR-11.3): where there is no record, it says so.
 */

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `T+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 90) return `${total} seconds`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** The proposal a human approved, latest first. There is usually none, and often one. */
function approvedProposal(session: Session): Proposal | undefined {
  return session.proposals.all
    .filter((p) => p.status === "approved" || p.status === "executed")
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))[0];
}

function rootCauseSection(session: Session): string[] {
  const approved = approvedProposal(session);
  if (approved) {
    return [
      "## Root cause",
      "",
      `**As diagnosed by the agent and approved by the human operator:**`,
      "",
      `> ${approved.hypothesis}`,
      "",
      `Cited: ${approved.evidenceIds.join(", ")}. Recorded as the approved diagnosis, not as a`,
      `finding of the system — the environment reports symptoms and never names a cause.`,
    ];
  }

  return [
    "## Root cause",
    "",
    "**Not recorded.** No diagnosis was proposed and approved during this incident, so there",
    "is nothing to attribute. The actions below were taken directly by a human operator, who",
    "did not have to state a reason for them and did not.",
  ];
}

function verificationSection(engine: Engine): string[] {
  const result = verifyRemediation(engine, {});
  if (!result.ok) {
    return ["## Verification", "", `Not available: ${result.error}`];
  }

  const data = result.data as {
    action_id: string;
    action: string;
    verdict: string;
    comparisons: Array<{
      service: string;
      error_rate: { before: number; now: number };
      p99_ms: { before: number; now: number };
    }>;
  };

  const lines = [
    "## Verification",
    "",
    `Verdict for ${data.action_id} (${data.action}): **${data.verdict}**`,
    "",
  ];
  for (const c of data.comparisons) {
    lines.push(
      `- ${c.service}: error rate ${pct(c.error_rate.before)} → ${pct(c.error_rate.now)}, ` +
        `p99 ${Math.round(c.p99_ms.before)}ms → ${Math.round(c.p99_ms.now)}ms`,
    );
  }
  return lines;
}

export function assemblePostmortem(session: Session): { ok: true; text: string } | { ok: false; error: string } {
  const { engine, evidence, audit } = session;
  const incident = engine.incident;

  if (!incident) {
    return {
      ok: false,
      error:
        "There is no incident to write up. A postmortem is assembled from an incident record, " +
        "its evidence and its audit trail; none of those exist yet.",
    };
  }

  const now = engine.world.nowMs;
  const end = incident.resolvedAt ?? incident.recoveryVerifiedAt ?? now;

  const lines: string[] = [
    `# Postmortem — ${incident.id}`,
    "",
    `**${incident.title}**`,
    "",
    `| | |`,
    `|---|---|`,
    `| Severity | ${incident.severity} |`,
    `| Status | ${incident.status} |`,
    `| Affected | ${incident.affectedServices.join(", ")} |`,
    `| Opened | ${clock(incident.openedAt)} |`,
    `| ${incident.resolvedAt !== null ? "Resolved" : "Open for"} | ${
      incident.resolvedAt !== null ? clock(incident.resolvedAt) : duration(now - incident.openedAt)
    } |`,
    `| Time to resolution | ${
      incident.resolvedAt !== null ? duration(incident.resolvedAt - incident.openedAt) : "not yet resolved"
    } |`,
    "",
    `Opening signals: ${incident.openingSignals.service} at ` +
      `${pct(incident.openingSignals.errorRate)} error rate and ` +
      `${Math.round(incident.openingSignals.p99)}ms p99 — the measurements the severity was ` +
      `assigned from.`,
    "",
    ...rootCauseSection(session),
    "",
    "## Timeline",
    "",
  ];

  for (const entry of incident.timeline) {
    lines.push(`- ${clock(entry.t)} · ${entry.actor} · ${entry.message}`);
  }

  lines.push("", "## Actions taken", "");
  const actions = engine.actions;
  if (actions.length === 0) {
    lines.push("None. The incident was not acted on.");
  } else {
    for (const action of actions) {
      /*
       * The approver is a human in every case, and the distinction worth recording is
       * whether a human also *initiated* it. An agent's action reaching the environment
       * means a person approved it; that is the only way one can (FR-8.3).
       */
      const approver =
        action.actor === "agent"
          ? "proposed by the agent, approved by the human operator"
          : "taken directly by the human operator, who is the approver";
      lines.push(`- ${clock(action.t)} · **${action.id}** · ${action.summary} (${approver})`);
    }
  }

  lines.push("", ...verificationSection(engine));

  lines.push("", "## Evidence cited", "");
  const cited = evidence.all().filter((entry) => entry.channels.has("webmcp"));
  if (cited.length === 0) {
    lines.push("No evidence was retrieved through the tool layer during this incident.");
  } else {
    for (const entry of cited.slice(-20)) {
      lines.push(`- ${entry.id} · ${entry.tool} · ${clock(entry.simMs)}`);
    }
    if (cited.length > 20) lines.push(`- …and ${cited.length - 20} earlier`);
  }

  lines.push("", "## Operations", "");
  const trail = audit.all;
  const refused = trail.filter((e) => e.status !== "ok").length;
  lines.push(
    `${trail.length} operations recorded, ${refused} of them refused or failed. ` +
      `Human actions and agent tool calls are in one trail, distinguished by source and actor.`,
  );

  lines.push(
    "",
    "---",
    "",
    `Assembled from the incident record, the evidence registry and the audit trail at ` +
      `${clock(end)}. Nothing above is narrated: where there is no record, it says so.`,
  );

  return { ok: true, text: lines.join("\n") };
}
