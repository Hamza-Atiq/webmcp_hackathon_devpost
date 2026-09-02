import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { invokeTool, TOOL_NAMES } from "../src/mcp/register";
import { resetSession, session } from "../src/session";
import { ProposalStore } from "../src/mcp/proposals";
import { APPROVAL_TIMEOUT_MS, MAX_PENDING_PROPOSALS } from "../src/engine/constants";
import type { ToolResult } from "../src/mcp/contracts";

/**
 * The approval gate — FR-7 and FR-8.
 *
 * This is the most important test file in the project. Everything else asserts that an
 * incident console works; these assert the one claim the product is actually making —
 * that an agent can investigate freely and can change nothing without a person's click.
 */

const AGENT = { source: "webmcp", actor: "agent" } as const;
const HUMAN_IN_UI = { source: "ui", actor: "human" } as const;

/** Run the environment into the incident, with the session's own engine. */
function intoIncident(): void {
  const { engine } = session();
  engine.advanceSeconds(60);
  engine.startScenario("s1");
  engine.advanceSeconds(180);
}

/** Two citable ids from two different sources, which is what FR-7.2 demands. */
async function gatherEvidence(): Promise<string[]> {
  const logs = await invokeTool("search_logs", { service: "checkout-service", level: "error", limit: 3 }, AGENT);
  const deploys = await invokeTool("list_recent_deployments", { service: "checkout-service" }, AGENT);
  if (!logs.ok || !deploys.ok) throw new Error("evidence gathering failed");
  return [logs.evidence_ids[0]!, deploys.evidence_ids[0]!];
}

async function propose(overrides: Record<string, unknown> = {}): Promise<ToolResult> {
  const evidence_ids = (overrides.evidence_ids as string[]) ?? (await gatherEvidence());
  return invokeTool(
    "propose_remediation",
    {
      hypothesis: "checkout-service is queueing on database connections since the last deployment",
      service: "checkout-service",
      action: "rollback_deployment",
      evidence_ids,
      ...overrides,
    },
    AGENT,
  );
}

function proposalId(result: ToolResult): string {
  if (!result.ok) throw new Error(`expected a proposal, got: ${result.error}`);
  return (result.data as { proposal_id: string }).proposal_id;
}

describe("evidence validation — FR-7", () => {
  beforeEach(() => {
    resetSession();
    intoIncident();
  });

  it("refuses a proposal made as the very first tool call — the FR-7.3 failure test", async () => {
    const result = await propose({ evidence_ids: ["log_0001", "dep_0006"] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("never returned to you");
      expect(result.error).toContain("search_logs");
    }
    expect(session().proposals.all).toHaveLength(0);
  });

  it("refuses a fabricated id even when real evidence sits beside it", async () => {
    const [log] = await gatherEvidence();
    const result = await propose({ evidence_ids: [log!, "log_999999"] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("log_999999");
  });

  it("refuses evidence a human browsed but the agent never retrieved — FR-13.5", async () => {
    const browsed = await invokeTool("get_incident", {}, HUMAN_IN_UI);
    const [log] = await gatherEvidence();
    if (!browsed.ok) throw new Error("setup failed");

    const result = await propose({ evidence_ids: [browsed.evidence_ids[0]!, log!] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("a human browsed it");
      expect(result.error).toContain("get_incident");
    }
  });

  it("refuses a single citation, however good it is", async () => {
    const [log] = await gatherEvidence();
    const result = await propose({ evidence_ids: [log!] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at least two");
  });

  it("refuses two ids drawn from the same source — FR-7.2", async () => {
    const logs = await invokeTool("search_logs", { service: "checkout-service", limit: 5 }, AGENT);
    if (!logs.ok) throw new Error("setup failed");

    const result = await propose({ evidence_ids: logs.evidence_ids.slice(0, 2) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("logs");
      expect(result.error).toContain("different kind");
    }
  });

  it("creates a pending proposal when the citations corroborate each other", async () => {
    const result = await propose();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.data as Record<string, unknown>;
    expect(data.proposal_id).toBe("prop_0001");
    expect(data.status).toBe("pending");
    expect(data.blast_radius).toBe("HIGH");
    expect(session().proposals.get("prop_0001")!.status).toBe("pending");
  });

  it("refuses a fourth open proposal, naming the limit — FR-0", async () => {
    const evidence = await gatherEvidence();
    for (let i = 0; i < MAX_PENDING_PROPOSALS; i++) {
      expect((await propose({ evidence_ids: evidence })).ok).toBe(true);
    }

    const overflow = await propose({ evidence_ids: evidence });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain(String(MAX_PENDING_PROPOSALS));
  });
});

describe("the approval gate — FR-8", () => {
  beforeEach(() => {
    resetSession();
    intoIncident();
  });

  it("blocks until a human approves, then applies the action", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    let settled = false;
    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT).then((r) => {
      settled = true;
      return r;
    });

    // Give the promise every chance to settle on its own. It must not.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled, "execute_remediation resolved without a human").toBe(false);
    expect(proposals.get(id)!.status).toBe("awaiting_approval");
    expect(engine.actions).toHaveLength(0);

    proposals.approve(id, engine.world.nowMs);
    const result = await call;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.action_id).toBe("act_0001");
    expect(proposals.get(id)!.status).toBe("executed");
    expect(engine.actions).toHaveLength(1);
    expect(engine.actions[0]!.actor).toBe("agent");
  });

  it("cannot be approved while merely pending — FR-8.1a", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    expect(proposals.approve(id, engine.world.nowMs)).toBe(false);
    expect(proposals.get(id)!.status).toBe("pending");
    expect(engine.actions).toHaveLength(0);
  });

  it("refuses a second concurrent execute for the same proposal — FR-8.4", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    const first = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    const second = await invokeTool("execute_remediation", { proposal_id: id }, AGENT);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("awaiting_approval");

    proposals.approve(id, engine.world.nowMs);
    expect((await first).ok).toBe(true);
    // The refused second call must not have applied anything of its own.
    expect(engine.actions).toHaveLength(1);
  });

  it("refuses to execute a proposal that already ran", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    proposals.approve(id, engine.world.nowMs);
    await call;

    const again = await invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("executed");
    expect(engine.actions).toHaveLength(1);
  });

  it("returns the human's reason on denial — FR-8.6", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    await new Promise((r) => setTimeout(r, 10));
    proposals.deny(id, "we are mid-sale, roll back after 6pm", engine.world.nowMs);

    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mid-sale");
    expect(engine.actions).toHaveLength(0);
    expect(proposals.get(id)!.status).toBe("denied");
  });

  it("keeps two open approvals independent — FR-8.7", async () => {
    const evidence = await gatherEvidence();
    const first = proposalId(await propose({ evidence_ids: evidence }));
    const second = proposalId(
      await propose({ evidence_ids: evidence, action: "restart_service" }),
    );
    const { proposals, engine } = session();

    const firstCall = invokeTool("execute_remediation", { proposal_id: first }, AGENT);
    const secondCall = invokeTool("execute_remediation", { proposal_id: second }, AGENT);
    await new Promise((r) => setTimeout(r, 10));

    proposals.deny(first, "not this one", engine.world.nowMs);
    const firstResult = await firstCall;
    expect(firstResult.ok).toBe(false);

    // The second call must still be waiting: one decision settles one proposal.
    expect(proposals.get(second)!.status).toBe("awaiting_approval");

    proposals.approve(second, engine.world.nowMs);
    expect((await secondCall).ok).toBe(true);
    expect(engine.actions).toHaveLength(1);
    expect(engine.actions[0]!.kind).toBe("restart_service");
  });

  it("cancels a waiting approval when the agent aborts — FR-8.8", async () => {
    const id = proposalId(await propose());
    const controller = new AbortController();
    const { proposals, engine } = session();

    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT, {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();

    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("aborted");
    expect(proposals.get(id)!.status).toBe("cancelled");
    expect(engine.actions).toHaveLength(0);
  });

  it("cancels open proposals when the incident is resolved out from under them", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    await new Promise((r) => setTimeout(r, 10));
    proposals.cancelOpen("the incident was resolved by a human", engine.world.nowMs);

    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("resolved by a human");
    expect(engine.actions).toHaveLength(0);
  });
});

describe("the timeout is wall-clock and settles exactly once — FR-8.5, FR-3.5", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSession();
    intoIncident();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires after 60 seconds with nothing applied", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1000);
    expect(proposals.get(id)!.status).toBe("awaiting_approval");

    await vi.advanceTimersByTimeAsync(2000);
    const result = await call;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expired");
    expect(proposals.get(id)!.status).toBe("expired");
    expect(engine.actions).toHaveLength(0);
  });

  it("does not let a late timer overwrite a decision that already happened", async () => {
    const id = proposalId(await propose());
    const { proposals, engine } = session();

    const call = invokeTool("execute_remediation", { proposal_id: id }, AGENT);
    await vi.advanceTimersByTimeAsync(100);
    proposals.approve(id, engine.world.nowMs);
    await call;

    // The 60-second timer is still out there. It must find nothing to do.
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS * 2);
    expect(proposals.get(id)!.status).toBe("executed");
    expect(engine.actions).toHaveLength(1);
  });

  it("measures the timeout on real time, whatever the simulation is doing", () => {
    /*
     * FR-3.5: at 60x a human still gets a full real minute. The store holds a wall-clock
     * timer and never reads the simulated clock — the constructor's default is the only
     * duration it knows, and the simulated clock cannot reach it.
     */
    const store = new ProposalStore();
    expect(APPROVAL_TIMEOUT_MS).toBe(60_000);
    expect(String(store.constructor)).not.toContain("nowMs");
  });
});

describe("the failure test for FR-8.3", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSession();
    intoIncident();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("changes nothing in the environment across every tool, in any order, with no human click", async () => {
    const { engine } = session();

    const snapshot = () =>
      JSON.stringify({
        services: engine.world.services,
        deployments: engine.world.deployments.map((d) => d.rolledBack),
        flags: engine.world.flags.map((f) => f.enabled),
        actions: engine.actions.length,
        transitions: engine.world.transitions.length,
      });

    const before = snapshot();

    // Every tool, including the two that can change something, with arguments good enough
    // to succeed. The only thing missing is a person.
    const evidence = await gatherEvidence();
    const args: Record<string, Record<string, unknown>> = {
      list_services: {},
      get_service_health: { service: "checkout-service" },
      get_metrics: { service: "checkout-service", metric: "p99" },
      search_logs: { service: "checkout-service" },
      get_trace: { trace_id: engine.store.traces.at(-1)!.id },
      list_traces: { service: "checkout-service" },
      list_recent_deployments: {},
      get_deployment_diff: { deployment_id: engine.world.deployments.at(-1)!.id },
      get_runbook: { symptom: "latency" },
      get_service_ownership: { service: "checkout-service" },
      get_incident: {},
      verify_remediation: {},
      propose_remediation: {
        hypothesis: "the pool is exhausted",
        service: "checkout-service",
        action: "rollback_deployment",
        evidence_ids: evidence,
      },
      // The proposal the loop itself creates a moment earlier. Pointing this at an id that
      // never existed would prove only that unknown ids are refused — the claim under test
      // is that a *valid* execution changes nothing without a person.
      execute_remediation: { proposal_id: "prop_0001" },
    };

    for (const name of TOOL_NAMES) {
      const call = invokeTool(name, args[name] ?? {}, AGENT);
      // execute_remediation blocks; let it reach its timeout rather than deadlocking.
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 1000);
      await call;
    }

    expect(snapshot()).toBe(before);
    expect(engine.actions).toHaveLength(0);

    // And it really did reach the gate rather than being turned away at the door.
    expect(session().proposals.get("prop_0001")!.status).toBe("expired");
  });
});
