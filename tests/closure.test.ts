import { describe, it, expect, beforeEach } from "vitest";
import { invokeTool } from "../src/mcp/register";
import { assemblePostmortem } from "../src/mcp/postmortem";
import { resetSession, session } from "../src/session";
import { SCENARIO_IDS, type ScenarioId } from "../src/engine";

/**
 * FR-11 — closing an incident, and FR-12.4 — doing it with no agent at all.
 *
 * The postmortem is the one document the project produces, and the rule it has to obey is
 * uncomfortable on purpose: it records the diagnosis a human approved, attributed to
 * whoever wrote it, and never a root cause of its own. It can therefore be wrong. These
 * assert that it is assembled from records rather than narrated, and that it does not
 * quietly become an oracle.
 */

const AGENT = { source: "webmcp", actor: "agent" } as const;

function intoIncident(scenario: ScenarioId = "s1"): void {
  const { engine } = session();
  engine.advanceSeconds(30);
  engine.startScenario(scenario);
  engine.advanceSeconds(180);
}

async function evidenceIds(): Promise<string[]> {
  const logs = await invokeTool(
    "search_logs",
    { service: "checkout-service", level: "error", limit: 3 },
    AGENT,
  );
  const deploys = await invokeTool(
    "list_recent_deployments",
    { service: "checkout-service" },
    AGENT,
  );
  if (!logs.ok || !deploys.ok) throw new Error("evidence gathering failed");
  return [logs.evidence_ids[0]!, deploys.evidence_ids[0]!];
}

describe("update_incident_status — FR-11.1", () => {
  beforeEach(() => {
    resetSession();
    intoIncident();
  });

  it("moves the incident and records the actor", async () => {
    const result = await invokeTool("update_incident_status", { status: "investigating" }, AGENT);
    expect(result.ok).toBe(true);
    expect(session().engine.incident!.status).toBe("investigating");

    const entry = session().engine.incident!.timeline.at(-1)!;
    expect(entry.actor).toBe("agent");
  });

  it("refuses to resolve an incident the measurements say is still happening", async () => {
    const result = await invokeTool("update_incident_status", { status: "resolved" }, AGENT);
    expect(result.ok).toBe(false);
    expect(session().engine.incident!.status).not.toBe("resolved");
  });

  it("refuses a status nobody defined, and says which exist", async () => {
    const result = await invokeTool("update_incident_status", { status: "on fire" }, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("investigating");
  });

  it("changes nothing about the environment — it is Class B", async () => {
    const before = JSON.stringify(session().engine.world.services);
    await invokeTool("update_incident_status", { status: "mitigating" }, AGENT);
    expect(JSON.stringify(session().engine.world.services)).toBe(before);
  });
});

describe("generate_postmortem — FR-11.2, FR-11.3", () => {
  beforeEach(() => {
    resetSession();
  });

  it("refuses when there is no incident, rather than inventing one", async () => {
    const result = await invokeTool("generate_postmortem", {}, AGENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no incident");
  });

  it("records the approved hypothesis, attributed, and never a cause of its own", async () => {
    intoIncident();
    const ids = await evidenceIds();
    const hypothesis = "the pool was cut from 50 to 5 by the last deployment";

    const proposal = await invokeTool(
      "propose_remediation",
      {
        hypothesis,
        service: "checkout-service",
        action: "rollback_deployment",
        evidence_ids: ids,
      },
      AGENT,
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    const id = (proposal.data as { proposal_id: string }).proposal_id;
    const { proposals, engine } = session();
    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    proposals.approve(id, engine.world.nowMs);
    expect((await call).ok).toBe(true);

    engine.advanceSeconds(150);
    const result = await invokeTool("generate_postmortem", {}, AGENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = (result.data as { postmortem: string }).postmortem;

    // The diagnosis is present, quoted, and labelled as somebody's claim.
    expect(text).toContain(hypothesis);
    expect(text).toContain("approved by the human operator");

    // Assembled from records: the action, its id, and the verification verdict.
    expect(text).toContain("act_0001");
    expect(text).toContain("Verification");
    expect(text).toMatch(/Verdict for act_0001 \(.+\): \*\*passed\*\*/);

    // Evidence cited by id, not described.
    for (const id of ids) expect(text).toContain(id);

    /*
     * FR-2.5 — a postmortem is a document the agent reads back, so it is a disclosure
     * surface like any tool response. It must not name the scenario that is running.
     */
    for (const scenario of SCENARIO_IDS) {
      expect(text.includes(`"${scenario}"`), `postmortem names ${scenario}`).toBe(false);
    }
    expect(text.toLowerCase()).not.toContain("scenario 1");
  });

  it("says so plainly when nobody recorded a diagnosis", () => {
    intoIncident();
    session().engine.remediate("restart_service", "checkout-service", {}, "human");

    const assembled = assemblePostmortem(session());
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    expect(assembled.text).toContain("Not recorded");
    expect(assembled.text).toContain("taken directly by the human operator");
  });
});

/**
 * FR-12.4 — detect, investigate, remediate, verify, postmortem, with no agent involved.
 *
 * Written as a whole arc rather than as five assertions, because the requirement is that
 * the *sequence* is completable by a person: every step here goes through the same engine
 * operations the dashboard's own controls call.
 */
describe("a human can close an incident alone — FR-12.4", () => {
  it("runs the whole arc with no tool call from an agent", () => {
    resetSession();
    const { engine } = session();

    engine.advanceSeconds(30);
    engine.startScenario("s1");
    engine.advanceSeconds(180);
    expect(engine.incident, "no incident to work on").not.toBeNull();

    // Investigate: everything an agent could read, a human reads from the same engine.
    expect(engine.store.logs.some((l) => l.service === "checkout-service")).toBe(true);
    expect(engine.runbooks("pool").length).toBeGreaterThan(0);
    expect(engine.ownership("checkout-service")).toBeDefined();

    expect(engine.setIncidentStatus("investigating", "human").ok).toBe(true);

    const outcome = engine.remediate("rollback_deployment", "checkout-service", {}, "human");
    expect(outcome.ok).toBe(true);

    engine.advanceSeconds(150);
    expect(engine.setIncidentStatus("resolved", "human").ok).toBe(true);

    const assembled = assemblePostmortem(session());
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.text).toContain("Time to resolution");
    expect(assembled.text).toContain("taken directly by the human operator");
  });
});
