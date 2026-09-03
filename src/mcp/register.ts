import { notifySession, session, type Session } from "../session";
import { summarise, type AuditActor, type AuditSource } from "./audit";
import { refuse, type ToolResult } from "./contracts";
import { ALL_TOOLS, type ToolName } from "./schemas";
import type { Args } from "./tools/readonly";
import * as readonly from "./tools/readonly";
import {
  executeRemediation,
  generatePostmortem,
  proposeRemediation,
  updateIncidentStatus,
} from "./tools/writes";
import type { SideEffectClass } from "./audit";

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

export interface InvokeOptions {
  signal?: AbortSignal;
  /** Called when a tool changes something the interface must re-render for. */
  onStateChange?: () => void;
}

/**
 * Handlers take the whole session, not just the engine.
 *
 * The read-only twelve only ever touch `engine`, but the write tools need the evidence
 * registry and the proposal store, and giving every tool the same shape keeps
 * `invokeTool` a single path — which is what makes the audit trail and the evidence
 * registry incapable of disagreeing about what happened.
 */
type Handler = (
  session: Session,
  args: Args,
  options: InvokeOptions,
) => ToolResult | Promise<ToolResult>;

/**
 * Every declared tool must have a handler, and TypeScript enforces it: the key type is
 * the union of declared names, so adding a tool to `schemas.ts` without implementing it
 * fails the build rather than presenting an agent with a tool that throws.
 */
const HANDLERS: Record<ToolName, Handler> = {
  list_services: (s) => readonly.listServices(s.engine),
  get_service_health: (s, args) => readonly.getServiceHealth(s.engine, args),
  get_metrics: (s, args) => readonly.getMetrics(s.engine, args),
  search_logs: (s, args) => readonly.searchLogs(s.engine, args),
  get_trace: (s, args) => readonly.getTrace(s.engine, args),
  list_traces: (s, args) => readonly.listTraces(s.engine, args),
  list_recent_deployments: (s, args) => readonly.listRecentDeployments(s.engine, args),
  get_deployment_diff: (s, args) => readonly.getDeploymentDiff(s.engine, args),
  get_runbook: (s, args) => readonly.getRunbook(s.engine, args),
  get_service_ownership: (s, args) => readonly.getServiceOwnership(s.engine, args),
  get_incident: (s) => readonly.getIncident(s.engine),
  verify_remediation: (s, args) => readonly.verifyRemediation(s.engine, args),
  propose_remediation: (s, args) => proposeRemediation(s, args),
  execute_remediation: (s, args, options) => executeRemediation(s, args, options),
  update_incident_status: (s, args) => updateIncidentStatus(s, args),
  generate_postmortem: (s) => generatePostmortem(s),
};

/** FR-0's classes, and the reason `execute_remediation` is gated and nothing else is. */
export const SIDE_EFFECT_CLASS: Record<ToolName, SideEffectClass> = {
  list_services: "A",
  get_service_health: "A",
  get_metrics: "A",
  search_logs: "A",
  get_trace: "A",
  list_traces: "A",
  list_recent_deployments: "A",
  get_deployment_diff: "A",
  get_runbook: "A",
  get_service_ownership: "A",
  get_incident: "A",
  verify_remediation: "A",
  propose_remediation: "B",
  execute_remediation: "C",
  update_incident_status: "B",
  generate_postmortem: "B",
};

export const TOOL_NAMES: ToolName[] = ALL_TOOLS.map((tool) => tool.name);

/** Kept for the console harness and the tests written against the read-only layer. */
export const READ_ONLY_TOOL_NAMES = TOOL_NAMES;

/**
 * Invoke a tool and record it — the one path every call takes, whatever surface it came
 * from, so the audit trail and the evidence registry cannot disagree with each other.
 *
 * Asynchronous because one tool genuinely takes as long as a person takes to decide.
 * `execute_remediation` holds its promise open across a human's click, which is the whole
 * point of the product, and `duration_ms` for that call therefore measures deliberation
 * rather than computation.
 *
 * `source` is how the call physically arrived and is the field FR-13.5 keys evidence on:
 * only ids returned over WebMCP can support an agent's citation. `actor` is descriptive
 * and nothing load-bearing depends on it, because the page genuinely cannot tell an agent
 * from a human invoking the same tool by hand in the DevTools panel (FR-13.1a). Keeping
 * the two fields separate is what stops that limitation from being quietly papered over.
 */
export async function invokeTool(
  name: string,
  args: Args,
  origin: { source: AuditSource; actor: AuditActor },
  options: InvokeOptions = {},
): Promise<ToolResult> {
  const current = session();
  const { engine, evidence, audit } = current;
  const started = performance.now(); // Wall-clock, for duration_ms only — FR-3.1.

  const handler = HANDLERS[name as ToolName];
  let result: ToolResult;
  let status: "ok" | "refused" | "error";

  if (!handler) {
    result = refuse(`Unknown tool ${JSON.stringify(name)}. Available: ${TOOL_NAMES.join(", ")}.`);
    status = "refused";
  } else {
    try {
      result = await handler(current, args, {
        ...options,
        onStateChange: () => {
          options.onStateChange?.();
          notifySession();
        },
      });
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
      args: summarise(JSON.stringify(args ?? {}), 80),
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
      ? summarise(describe(result))
      : summarise(result.error),
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    status,
    side_effect_class: SIDE_EFFECT_CLASS[name as ToolName] ?? "A",
  });

  // Tool calls arrive from outside React; without this the activity log would sit empty
  // while an agent worked.
  notifySession();
  return result;
}

/** What the operation actually did, for a human reading the trail. */
function describe(result: Extract<ToolResult, { ok: true }>): string {
  const data = result.data as Record<string, unknown> | null;
  if (data && typeof data === "object") {
    if (typeof data.proposal_id === "string" && typeof data.action_id === "string") {
      return `${data.proposal_id} executed as ${data.action_id}: ${String(data.applied ?? "")}`;
    }
    if (typeof data.proposal_id === "string") {
      return `${data.proposal_id} proposed: ${String(data.action ?? "")} on ${String(data.service ?? "")}`;
    }
  }
  return `${result.evidence_ids.length} record(s): ${result.evidence_ids.join(", ")}`;
}

export function registerTools(): void {
  if (registered) return;
  registered = true;

  if (!webmcpAvailable()) return;

  for (const tool of ALL_TOOLS) {
    void document.modelContext!.registerTool({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      /*
       * An agent calling a tool is `source: webmcp`. `actor: agent` is the page's
       * assumption, not a determination — see the note on `invokeTool`.
       *
       * The abort signal is forwarded because FR-8.8 turns on it: an agent that gives up
       * on a blocked approval must cancel it, not leave a human staring at a prompt whose
       * answer nobody is waiting for.
       */
      execute: async (input, context) =>
        invokeTool(tool.name, input ?? {}, { source: "webmcp", actor: "agent" }, {
          signal: context?.signal,
        }),
    });
  }
}
