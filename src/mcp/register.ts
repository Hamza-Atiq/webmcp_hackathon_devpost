import type { Engine } from "../engine";
import { notifySession, session } from "../session";
import { summarise, type AuditActor, type AuditSource } from "./audit";
import { refuse, type ToolResult } from "./contracts";
import { READ_ONLY_TOOLS, type ReadOnlyToolName } from "./schemas";
import type { Args } from "./tools/readonly";
import * as readonly from "./tools/readonly";

/**
 * WebMCP tool registration — FR-14.
 *
 * Called exactly once, from `main.tsx`, BEFORE React renders — never from a component
 * effect. React StrictMode double-invokes effects in development, and
 * `document.modelContext.registerTool` rejects a name that is already registered with an
 * `InvalidStateError` *without replacing the existing tool*. The symptom of that bug is a
 * missing tool rather than an obvious crash, so it is worth being structurally impossible.
 *
 * This module is a binding and holds no behaviour. Everything a tool does lives in
 * `tools/readonly.ts` as a plain function, which is what lets the same code be verified
 * headlessly, from the browser console with no WebMCP present, and through the real API.
 */

let registered = false;

/** FR-14.6 — the app must work normally in a browser with no WebMCP support. */
export function webmcpAvailable(): boolean {
  return typeof document !== "undefined" && "modelContext" in document;
}

type Handler = (engine: Engine, args: Args) => ToolResult;

/**
 * Every declared tool must have a handler, and TypeScript enforces it: the key type is
 * the union of declared names, so adding a tool to `schemas.ts` without implementing it
 * fails the build rather than presenting an agent with a tool that throws.
 */
const HANDLERS: Record<ReadOnlyToolName, Handler> = {
  list_services: (engine) => readonly.listServices(engine),
  get_service_health: (engine, args) => readonly.getServiceHealth(engine, args),
  get_metrics: (engine, args) => readonly.getMetrics(engine, args),
  search_logs: (engine, args) => readonly.searchLogs(engine, args),
  get_trace: (engine, args) => readonly.getTrace(engine, args),
  list_traces: (engine, args) => readonly.listTraces(engine, args),
  list_recent_deployments: (engine, args) => readonly.listRecentDeployments(engine, args),
  get_deployment_diff: (engine, args) => readonly.getDeploymentDiff(engine, args),
  get_runbook: (engine, args) => readonly.getRunbook(engine, args),
  get_service_ownership: (engine, args) => readonly.getServiceOwnership(engine, args),
  get_incident: (engine) => readonly.getIncident(engine),
  verify_remediation: (engine, args) => readonly.verifyRemediation(engine, args),
};

export const READ_ONLY_TOOL_NAMES = READ_ONLY_TOOLS.map((tool) => tool.name);

/**
 * Invoke a tool and record it — the one path every call takes, whatever surface it came
 * from, so the audit trail and the evidence registry cannot disagree with each other.
 *
 * `source` is how the call physically arrived and is the field FR-13.5 keys evidence on:
 * only ids returned over WebMCP can support an agent's citation. `actor` is descriptive
 * and nothing load-bearing depends on it, because the page genuinely cannot tell an agent
 * from a human invoking the same tool by hand in the DevTools panel (FR-13.1a). Keeping
 * the two fields separate is what stops that limitation from being quietly papered over.
 */
export function invokeTool(
  name: string,
  args: Args,
  origin: { source: AuditSource; actor: AuditActor },
): ToolResult {
  const { engine, evidence, audit } = session();
  const started = performance.now(); // Wall-clock, for duration_ms only — FR-3.1.

  const handler = HANDLERS[name as ReadOnlyToolName];
  let result: ToolResult;
  let status: "ok" | "refused" | "error";

  if (!handler) {
    result = refuse(`Unknown tool ${JSON.stringify(name)}. Available: ${READ_ONLY_TOOL_NAMES.join(", ")}.`);
    status = "refused";
  } else {
    try {
      result = handler(engine, args);
      status = result.ok ? "ok" : "refused";
    } catch (error) {
      /*
       * A tool must never throw at an agent: an exception arrives as a transport failure
       * with no guidance in it. This is the last line of that rule, and FR-13.3 requires
       * the failure to be recorded rather than swallowed.
       */
      result = refuse(
        `${name} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. ` +
          `This is a defect in the page, not in your call.`,
      );
      status = "error";
    }
  }

  if (result.ok) {
    evidence.record(result.evidence_ids, {
      channel: origin.source,
      tool: name,
      simMs: engine.world.nowMs,
    });
  }

  audit.add({
    timestamp: engine.world.nowMs,
    kind: origin.source === "webmcp" ? "tool_call" : "ui_action",
    operation: name,
    source: origin.source,
    actor: origin.actor,
    arguments: summarise(JSON.stringify(args ?? {})),
    result_summary: result.ok
      ? summarise(`${result.evidence_ids.length} record(s): ${result.evidence_ids.join(", ")}`)
      : summarise(result.error),
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    status,
    side_effect_class: "A",
  });

  // Tool calls arrive from outside React; without this the activity log would sit empty
  // while an agent worked.
  notifySession();
  return result;
}

export function registerTools(): void {
  if (registered) return;
  registered = true;

  if (!webmcpAvailable()) return;

  for (const tool of READ_ONLY_TOOLS) {
    void document.modelContext!.registerTool({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      /*
       * An agent calling a tool is `source: webmcp`. `actor: agent` is the page's
       * assumption, not a determination — see the note on `invokeTool`.
       */
      execute: async (input) => invokeTool(tool.name, input ?? {}, { source: "webmcp", actor: "agent" }),
    });
  }
}
