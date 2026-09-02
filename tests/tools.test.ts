import { describe, it, expect, beforeEach } from "vitest";
import { Engine } from "../src/engine";
import { SIZE_CEILING, SIZE_TARGET } from "../src/mcp/bounded";
import { toText, type ToolResult } from "../src/mcp/contracts";
import { READ_ONLY_TOOLS } from "../src/mcp/schemas";
import { invokeTool, READ_ONLY_TOOL_NAMES } from "../src/mcp/register";
import { resetSession, session } from "../src/session";
import * as tools from "../src/mcp/tools/readonly";

/**
 * The read-only tool layer — spec 003, FR-6, FR-7, FR-13, FR-14.5.
 *
 * These call the tool functions directly rather than through `registerTool`, which is
 * the point of the split: bounds, refusals and evidence rules are behaviour, and
 * behaviour should not need a browser to check. Registration is the one thing this file
 * cannot prove, and the DevTools panel check exists for exactly that gap.
 */

/** An engine deep enough into the incident to have logs, traces and a live incident. */
function investigating(seed = 42): Engine {
  const engine = new Engine(seed);
  engine.advanceSeconds(60);
  engine.startScenario("s1");
  engine.advanceSeconds(180);
  return engine;
}

function expectOk(result: ToolResult): Extract<ToolResult, { ok: true }> {
  expect(result.ok, result.ok ? "" : result.error).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** Every tool, at the largest response its parameters allow. */
function maximalCalls(engine: Engine): Array<{ name: string; run: () => ToolResult }> {
  const trace = engine.store.traces[engine.store.traces.length - 1]!;
  const deployment = engine.world.deployments[engine.world.deployments.length - 1]!;

  return [
    { name: "list_services", run: () => tools.listServices(engine) },
    { name: "get_service_health", run: () => tools.getServiceHealth(engine, { service: "checkout-service" }) },
    {
      name: "get_metrics",
      run: () => tools.getMetrics(engine, { service: "checkout-service", metric: "p99", window_seconds: 1800 }),
    },
    { name: "search_logs", run: () => tools.searchLogs(engine, { window_seconds: 1800, limit: 50 }) },
    { name: "get_trace", run: () => tools.getTrace(engine, { trace_id: trace.id }) },
    {
      name: "list_traces",
      run: () => tools.listTraces(engine, { service: "checkout-service", window_seconds: 1800, limit: 25 }),
    },
    {
      name: "list_recent_deployments",
      run: () => tools.listRecentDeployments(engine, { window_seconds: 86_400, limit: 25 }),
    },
    { name: "get_deployment_diff", run: () => tools.getDeploymentDiff(engine, { deployment_id: deployment.id }) },
    { name: "get_runbook", run: () => tools.getRunbook(engine, {}) },
    { name: "get_service_ownership", run: () => tools.getServiceOwnership(engine, { service: "checkout-service" }) },
    { name: "get_incident", run: () => tools.getIncident(engine) },
    { name: "verify_remediation", run: () => tools.verifyRemediation(engine, {}) },
  ];
}

describe("output bounds — FR-0", () => {
  it("keeps every tool under the hard ceiling at maximum parameters", () => {
    const engine = investigating();
    engine.rollback("checkout-service", "human"); // so verify_remediation has an action

    for (const { name, run } of maximalCalls(engine)) {
      const size = toText(run()).length;
      expect(size, `${name} returned ${size} characters`).toBeLessThanOrEqual(SIZE_CEILING);
    }
  });

  it("reports what it dropped rather than shrinking silently", () => {
    const engine = investigating();
    const result = expectOk(tools.searchLogs(engine, { window_seconds: 1800, limit: 50 }));

    expect(result.truncated).toBe(true);
    expect(result.total_count).toBeGreaterThan(result.returned_count!);
    expect(result.narrow_by).toBeTruthy();
    // Never a half record: the ids returned must match the entries returned.
    const data = result.data as { entries: Array<{ id: string }> };
    expect(data.entries).toHaveLength(result.returned_count!);
    expect(result.evidence_ids).toEqual(data.entries.map((e) => e.id));
  });

  it("stays inside the design target for the ordinary calls an agent makes first", () => {
    const engine = investigating();
    const opening = [
      tools.listServices(engine),
      tools.getServiceHealth(engine, { service: "checkout-service" }),
      tools.getIncident(engine),
    ];
    for (const result of opening) expect(toText(result).length).toBeLessThanOrEqual(SIZE_TARGET);
  });
});

describe("every response is citable — FR-6.1", () => {
  it("returns at least one evidence id from every successful call", () => {
    const engine = investigating();
    engine.rollback("checkout-service", "human");

    for (const { name, run } of maximalCalls(engine)) {
      const result = run();
      expect(result.ok, `${name} refused`).toBe(true);
      if (result.ok) expect(result.evidence_ids.length, `${name} returned no ids`).toBeGreaterThan(0);
    }
  });

  it("mints a fresh series id per metrics response, so ids cannot be reused across runs", () => {
    const engine = investigating();
    const first = expectOk(tools.getMetrics(engine, { service: "checkout-service", metric: "p99" }));
    const second = expectOk(tools.getMetrics(engine, { service: "checkout-service", metric: "p99" }));

    expect(first.evidence_ids[0]).not.toBe(second.evidence_ids[0]);
    expect(first.evidence_ids[0]).toMatch(/^met_\d+$/);
  });
});

describe("refusals are instructive — spec 003 §4, FR-14.5", () => {
  const engine = investigating();

  it("names the valid values for an unknown service", () => {
    const result = tools.getServiceHealth(engine, { service: "chekout-service" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("chekout-service");
      expect(result.error).toContain("checkout-service");
    }
  });

  it("names the parameter and gives an example when one is missing", () => {
    const result = tools.getTrace(engine, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("trace_id");
      expect(result.error).toMatch(/get_trace\(/);
    }
  });

  it("refuses a window that runs backwards rather than guessing at it", () => {
    const result = tools.getMetrics(engine, { service: "checkout-service", metric: "p99", window_seconds: -30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("positive");
  });

  it("clamps an over-range limit and says so, because the caller still wants the records", () => {
    const result = expectOk(tools.searchLogs(engine, { limit: 500 }));
    expect(result.narrow_by).toContain("clamped");
    expect((result.data as { entries: unknown[] }).entries.length).toBeLessThanOrEqual(50);
  });

  it("tells an aged-out trace apart from one that never existed — spec 003 §5a", () => {
    /*
     * Past the trace horizon on purpose. The buffer holds roughly five minutes, so an
     * engine only four minutes in has evicted nothing and this case would pass by never
     * arising — which is the failure mode the test exists to prevent.
     */
    const engine = investigating();
    engine.advanceSeconds(200);

    const minted = engine.world.counters["trc"] ?? 0;
    const live = new Set(engine.store.traces.map((t) => t.id));

    let evicted: string | null = null;
    for (let n = 1; n <= minted && evicted === null; n++) {
      const id = `trc_${String(n).padStart(4, "0")}`;
      if (!live.has(id)) evicted = id;
    }
    expect(evicted, "the buffer should have evicted something by now").not.toBeNull();

    const agedOut = tools.getTrace(engine, { trace_id: evicted! });
    expect(agedOut.ok).toBe(false);
    if (!agedOut.ok) expect(agedOut.error).toContain("no longer retained");

    const neverExisted = tools.getTrace(engine, { trace_id: "trc_999999" });
    expect(neverExisted.ok).toBe(false);
    if (!neverExisted.ok) expect(neverExisted.error).toContain("Unknown trace id");
  });

  it("returns the most specific runbook first, because bounding may show only one", () => {
    /*
     * "database latency" matches the pool runbook by an exact symptom and the general
     * latency procedure by a substring. In library order the general one came first and
     * bounding then dropped the better answer, so the precise procedure existed and was
     * unreachable — found by calling the tool on the live page, not by a test.
     */
    const result = expectOk(tools.getRunbook(engine, { symptom: "database latency" }));
    const returned = (result.data as { runbooks: Array<{ id: string }> }).runbooks;
    expect(returned[0]!.id).toBe("rb_pool_exhaustion");
  });

  it("refuses an unknown action_id with the list of real ones", () => {
    const withAction = investigating();
    withAction.rollback("checkout-service", "human");

    const result = tools.verifyRemediation(withAction, { action_id: "act_9999" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("act_0001");
  });
});

describe("verify_remediation is measured, not inferred — FR-10.2", () => {
  it("fails immediately after the correct fix, because the signals have not come back yet", () => {
    const engine = investigating();
    engine.rollback("checkout-service", "human");
    engine.advanceSeconds(5);

    const result = expectOk(tools.verifyRemediation(engine, {}));
    const data = result.data as { verdict: string; still_out_of_bounds: string[]; action_id: string };

    expect(data.action_id).toBe("act_0001");
    expect(data.verdict).not.toBe("passed");
    expect(data.still_out_of_bounds.length).toBeGreaterThan(0);
  });

  it("passes once the signals actually recovered and held", () => {
    const engine = investigating();
    engine.rollback("checkout-service", "human");
    engine.advanceSeconds(240);

    const data = expectOk(tools.verifyRemediation(engine, {})).data as { verdict: string };
    expect(data.verdict).toBe("passed");
  });

  it("names which action it verified when called with no argument — FR-10.1a", () => {
    const engine = investigating();
    engine.rollback("checkout-service", "human");
    engine.advanceSeconds(10);
    engine.rollback("payment-service", "agent");

    const data = expectOk(tools.verifyRemediation(engine, {})).data as { action_id: string; action: string };
    expect(data.action_id).toBe("act_0002");
    expect(data.action).toContain("payment-service");
  });
});

describe("no tool discloses the scenario — FR-2.5", () => {
  it("keeps mechanism and cause out of every tool description", () => {
    const giveaways = ["pool", "DB_POOL_MAX", "memory leak", "rollback the", "root cause is"];
    for (const tool of READ_ONLY_TOOLS) {
      const text = `${tool.title} ${tool.description}`.toLowerCase();
      for (const giveaway of giveaways) {
        expect(text, `${tool.name} description`).not.toContain(giveaway.toLowerCase());
      }
    }
  });

  it("keeps the cause out of the incident record and the service inventory", () => {
    const engine = investigating();
    const text = `${toText(tools.getIncident(engine))} ${toText(tools.listServices(engine))}`;
    for (const giveaway of ["pool", "DB_POOL_MAX", "v2.4.1", "rollback"]) {
      expect(text).not.toContain(giveaway);
    }
  });
});

describe("the trail and the registry — FR-13", () => {
  beforeEach(() => {
    resetSession();
    session().engine.advanceSeconds(60);
    session().engine.startScenario("s1");
    session().engine.advanceSeconds(180);
  });

  it("makes ids citable only when they were returned over WebMCP — FR-13.5", () => {
    const browsed = invokeTool("get_incident", {}, { source: "ui", actor: "human" });
    const fetched = invokeTool("list_services", {}, { source: "webmcp", actor: "agent" });
    expect(browsed.ok && fetched.ok).toBe(true);
    if (!browsed.ok || !fetched.ok) return;

    const { evidence } = session();
    expect(evidence.citable(fetched.evidence_ids[0]!)).toBe(true);
    // Seen by a human in the interface, never returned to the agent.
    expect(evidence.citable(browsed.evidence_ids[0]!)).toBe(false);
  });

  it("counts two ids of the same kind as one source — FR-4.8", () => {
    const logs = invokeTool("search_logs", { limit: 5 }, { source: "webmcp", actor: "agent" });
    expect(logs.ok).toBe(true);
    if (!logs.ok) return;

    const sources = session().evidence.citableSources(logs.evidence_ids);
    expect(sources.size).toBe(1);
    expect([...sources]).toEqual(["logs"]);
  });

  it("records refused calls with their reason rather than dropping them — FR-13.3", () => {
    invokeTool("get_service_health", { service: "nope" }, { source: "webmcp", actor: "agent" });

    const entry = session().audit.all.at(-1)!;
    expect(entry.status).toBe("refused");
    expect(entry.result_summary).toContain("nope");
    expect(entry.kind).toBe("tool_call");
    expect(entry.side_effect_class).toBe("A");
  });

  it("separates how a call arrived from who claims to have made it — FR-13.1a", () => {
    invokeTool("get_incident", {}, { source: "webmcp", actor: "human" });
    const entry = session().audit.all.at(-1)!;
    expect(entry.source).toBe("webmcp");
    expect(entry.actor).toBe("human");
    expect(entry.kind).toBe("tool_call");
  });

  it("reports the tools nobody has called — FR-13.4", () => {
    invokeTool("get_incident", {}, { source: "webmcp", actor: "agent" });
    const unused = session().audit.unused(READ_ONLY_TOOL_NAMES);

    expect(unused).not.toContain("get_incident");
    expect(unused).toContain("get_runbook");
    expect(unused.length).toBe(READ_ONLY_TOOL_NAMES.length - 1);
  });

  it("refuses an unknown tool name with the list of real ones", () => {
    const result = invokeTool("get_root_cause", {}, { source: "webmcp", actor: "agent" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("list_services");
  });
});

describe("declarations", () => {
  it("declares readOnlyHint on all twelve, and untrustedContentHint on the log tool — FR-6.2", () => {
    expect(READ_ONLY_TOOLS).toHaveLength(12);
    for (const tool of READ_ONLY_TOOLS) expect(tool.annotations.readOnlyHint).toBe(true);

    const logs = READ_ONLY_TOOLS.find((t) => t.name === "search_logs")!;
    expect(logs.annotations).toHaveProperty("untrustedContentHint", true);
  });

  it("carries the untrusted marker in the response body as well as the annotation", () => {
    const engine = investigating();
    const result = expectOk(tools.searchLogs(engine, { limit: 5 }));
    expect(result.content_trust).toBe("untrusted");
  });

  it("has a handler for every declared tool", () => {
    expect(READ_ONLY_TOOL_NAMES.sort()).toEqual(READ_ONLY_TOOLS.map((t) => t.name).sort());
  });
});
