import { ACTION_KINDS, SERVICE_NAMES, type ActionKind, type ServiceName } from "../../engine";
import { APPROVAL_TIMEOUT_MS } from "../../engine/constants";
import { missingParam, ok, refuse, unknownValue, type ToolResult } from "../contracts";
import { validateEvidence } from "../proposals";
import type { Session } from "../../session";
import type { Args } from "./readonly";

/**
 * The two tools that change something — `propose_remediation` (Class B) and
 * `execute_remediation` (Class C, and the only Class C tool there is).
 *
 * The asymmetry between them is the product's argument. Proposing is free: an agent may
 * reason, cite, and be told its reasoning is unsupported, all without touching anything.
 * Executing is the single narrow door through which the environment can change, and it
 * does not open without a human (FR-8.3).
 */

interface ProposalArgs {
  hypothesis: string;
  service: ServiceName;
  action: ActionKind;
  parameters: Record<string, unknown>;
  evidenceIds: string[];
}

function readProposalArgs(args: Args): ProposalArgs | ToolResult {
  if (typeof args.hypothesis !== "string" || args.hypothesis.trim().length === 0) {
    return missingParam(
      "hypothesis",
      'propose_remediation({ hypothesis: "checkout-service is queueing on database connections ' +
        'since dep_0006 cut the pool", service: "checkout-service", action: "rollback_deployment", ' +
        'evidence_ids: ["log_0350", "dep_0006"] })',
    );
  }
  if (!SERVICE_NAMES.includes(args.service as ServiceName)) {
    if (args.service === undefined) return missingParam("service", 'service: "checkout-service"');
    return unknownValue("service", args.service, SERVICE_NAMES);
  }
  if (!ACTION_KINDS.includes(args.action as ActionKind)) {
    if (args.action === undefined) return missingParam("action", 'action: "rollback_deployment"');
    return unknownValue("action", args.action, ACTION_KINDS);
  }
  if (!Array.isArray(args.evidence_ids) || args.evidence_ids.some((id) => typeof id !== "string")) {
    return missingParam("evidence_ids", 'evidence_ids: ["log_0350", "dep_0006"]');
  }

  return {
    hypothesis: args.hypothesis.trim(),
    service: args.service as ServiceName,
    action: args.action as ActionKind,
    parameters: (args.parameters as Record<string, unknown>) ?? {},
    evidenceIds: args.evidence_ids as string[],
  };
}

/** Only the parameters the named action actually reads, coerced and left to be clamped. */
function readParameters(action: ActionKind, raw: Record<string, unknown>) {
  switch (action) {
    case "scale_replicas":
      return { replicas: raw.replicas === undefined ? undefined : Number(raw.replicas) };
    case "disable_feature_flag":
      return { flag: typeof raw.flag === "string" ? raw.flag : undefined };
    case "shift_traffic":
      return { fraction: raw.fraction === undefined ? undefined : Number(raw.fraction) };
    default:
      return {};
  }
}

export function proposeRemediation(session: Session, args: Args): ToolResult {
  const parsed = readProposalArgs(args);
  if ("ok" in parsed) return parsed;

  /*
   * Evidence is validated once, here, and never re-checked. It records what the agent had
   * seen when it reasoned; traces age out within about five minutes, and expiring a
   * proposal for that reason would have nothing to do with its merit.
   */
  const validation = validateEvidence(session.evidence, parsed.evidenceIds);
  if (!validation.ok) return refuse(validation.error);

  const created = session.proposals.create({
    createdAt: session.engine.world.nowMs,
    hypothesis: parsed.hypothesis,
    service: parsed.service,
    action: parsed.action,
    parameters: readParameters(parsed.action, parsed.parameters),
    evidenceIds: parsed.evidenceIds,
  });
  if (!created.ok) return refuse(created.error);

  const { proposal } = created;
  return ok(
    {
      proposal_id: proposal.id,
      status: proposal.status,
      action: proposal.action,
      service: proposal.service,
      blast_radius: proposal.blastRadius,
      cited: proposal.evidenceIds,
      next_step:
        `The proposal is now visible to the human operator, who cannot act on it yet. Call ` +
        `execute_remediation({ proposal_id: "${proposal.id}" }) to request approval — that call ` +
        `blocks until a person approves or denies it, or ${APPROVAL_TIMEOUT_MS / 1000} seconds pass.`,
    },
    [],
  );
}

export async function executeRemediation(
  session: Session,
  args: Args,
  options: { signal?: AbortSignal; onStateChange?: () => void } = {},
): Promise<ToolResult> {
  const id = args.proposal_id;
  if (typeof id !== "string") {
    return missingParam("proposal_id", 'execute_remediation({ proposal_id: "prop_0001" })');
  }

  const { engine, proposals } = session;
  const requested = proposals.requestApproval(id, engine.world.nowMs, options);
  if (!requested.ok) return refuse(requested.error);

  const settlement = await requested.settled;
  const proposal = proposals.get(id)!;

  if (settlement.kind === "denied") {
    return refuse(
      `Proposal ${id} was denied by the human operator: "${settlement.reason}". Nothing was ` +
        `applied and the environment is unchanged.`,
    );
  }
  if (settlement.kind === "expired") {
    return refuse(
      `No decision within ${APPROVAL_TIMEOUT_MS / 1000} seconds, so proposal ${id} expired and ` +
        `nothing was applied. Propose again if the incident persists.`,
    );
  }
  if (settlement.kind === "cancelled") {
    return refuse(`Proposal ${id} was cancelled: ${settlement.reason}. Nothing was applied.`);
  }

  /*
   * Approved. The action is applied *after* the decision is recorded, which is why
   * `approved` and `executed` are separate statuses: if application failed and they were
   * one status, the record would claim a human approved something that never happened.
   *
   * `actor: agent` — the agent initiated this and the human permitted it. Recording the
   * human as the actor would erase the only distinction the product is about.
   */
  const outcome = engine.remediate(
    proposal.action,
    proposal.service,
    proposal.parameters,
    "agent",
  );
  options.onStateChange?.();

  if (!outcome.ok) {
    return refuse(
      `Proposal ${id} was approved, but the action could not be applied: ${outcome.error} ` +
        `The environment is unchanged and the proposal cannot be executed again.`,
    );
  }

  proposals.markExecuted(id, outcome.action.id, engine.world.nowMs);
  options.onStateChange?.();

  return ok(
    {
      proposal_id: id,
      status: "executed",
      action_id: outcome.action.id,
      applied: outcome.action.summary,
      next_step:
        `Effects apply through the simulation over time — no action recovers instantly. Call ` +
        `verify_remediation({ action_id: "${outcome.action.id}" }) after the signals have had a ` +
        `chance to move, and read the verdict rather than assuming this worked.`,
    },
    [],
  );
}
