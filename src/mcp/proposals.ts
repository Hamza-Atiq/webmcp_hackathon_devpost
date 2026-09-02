import { APPROVAL_TIMEOUT_MS, MAX_PENDING_PROPOSALS } from "../engine/constants";
import type { ActionKind, RemediationParams, ServiceName } from "../engine";
import { BLAST_RADIUS } from "../engine";
import type { EvidenceRegistry } from "./evidence";

/**
 * Proposals, the approval state machine, and the promise a human settles — FR-7, FR-8.
 *
 * This is the file the whole product is about. Everything else is an incident console;
 * this is the part where an agent asks and a person decides, with the agent's call held
 * open across the human's decision.
 *
 * Two properties are worth stating because they are easy to lose:
 *
 * **A proposal's hypothesis is stored, displayed, and read by no decision anywhere.** The
 * verdict on whether a remediation worked is measured (FR-10.2). The moment an agent's
 * confidence in its own reasoning starts counting as evidence, the gate becomes theatre.
 *
 * **Settlement happens exactly once.** Four things race — a human's click, a 60-second
 * wall-clock timer, an abort from the caller, and cancellation when the incident is
 * resolved out from under it. Whichever arrives first wins and the rest are no-ops. A
 * timer that fires after a human approved would otherwise move an executed proposal to
 * `expired`, which is a lie about something that already happened.
 */

export type ProposalStatus =
  | "pending"
  | "awaiting_approval"
  | "approved"
  | "executed"
  | "denied"
  | "expired"
  | "cancelled";

export interface Proposal {
  id: string;
  createdAt: number;
  status: ProposalStatus;
  hypothesis: string;
  service: ServiceName;
  action: ActionKind;
  parameters: RemediationParams;
  evidenceIds: string[];
  blastRadius: "LOW" | "MEDIUM" | "HIGH";
  /**
   * Wall-clock ms at which the approval expires, while one is being awaited.
   *
   * Real time, not simulated: the countdown a human watches has to be the same sixty
   * seconds the timer is counting, whatever the speed multiplier says (FR-3.5).
   */
  approvalDeadline: number | null;
  decidedAt: number | null;
  /** The human's words on denial — FR-8.6. */
  decisionReason: string | null;
  actionId: string | null;
}

export type Settlement =
  | { kind: "approved" }
  | { kind: "denied"; reason: string }
  | { kind: "expired" }
  | { kind: "cancelled"; reason: string };

/**
 * The only transitions that exist — FR-8.0.
 *
 * A table rather than scattered `if` statements, so a transition nobody wrote is
 * impossible rather than merely absent.
 */
const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "denied", "expired", "cancelled"],
  approved: ["executed"],
  executed: [],
  denied: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Which tool returns ids with this prefix — used to make a rejection actionable. */
const RETRIEVED_BY: Record<string, string> = {
  svc: "list_services",
  met: "get_metrics or get_service_health",
  log: "search_logs",
  trc: "list_traces or get_trace",
  dep: "list_recent_deployments",
  rb: "get_runbook",
  own: "get_service_ownership",
  inc: "get_incident",
};

function retrievedBy(id: string): string {
  const prefix = id.slice(0, id.indexOf("_"));
  return RETRIEVED_BY[prefix] ?? "one of the read-only tools";
}

export type Validation = { ok: true } | { ok: false; error: string };

/**
 * FR-7.2 to FR-7.4, in order, first failure wins.
 *
 * A caller fixing one problem at a time learns more than one handed a list, and the order
 * runs from "this id is not real" to "these ids do not corroborate each other" — which is
 * the order the mistakes actually get made in.
 */
export function validateEvidence(evidence: EvidenceRegistry, ids: readonly string[]): Validation {
  for (const id of ids) {
    const entry = evidence.entry(id);
    if (!entry) {
      return {
        ok: false,
        error:
          `Evidence id ${JSON.stringify(id)} was never returned to you in this run. Retrieve it ` +
          `first — ${retrievedBy(id)} returns ids of that kind. Evidence cannot be cited from a ` +
          `previous run or inferred from a pattern.`,
      };
    }
    if (!evidence.citable(id)) {
      return {
        ok: false,
        error:
          `Evidence id ${JSON.stringify(id)} exists but was not returned to you — a human browsed ` +
          `it in the interface. Call ${retrievedBy(id)} yourself to cite it.`,
      };
    }
  }

  if (ids.length < 2) {
    return {
      ok: false,
      error:
        `A proposal must cite at least two evidence ids from at least two different sources; ` +
        `${ids.length === 0 ? "none were" : "one was"} cited. One reading is a coincidence.`,
    };
  }

  const sources = evidence.citableSources(ids);
  if (sources.size < 2) {
    const only = [...sources][0] ?? "one source";
    return {
      ok: false,
      error:
        `All cited evidence is ${only}. A diagnosis needs corroboration from a different kind of ` +
        `evidence — the trace a log line points at, or the deployment that preceded the change.`,
    };
  }

  return { ok: true };
}

export class ProposalStore {
  private readonly proposals: Proposal[] = [];
  private readonly settlers = new Map<string, (settlement: Settlement) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextId = 1;

  /**
   * Wall-clock, and injectable only so the timeout can be tested without a real minute
   * passing. It never scales with the simulation multiplier: at 60x a human still gets a
   * full real minute to decide (FR-3.5, FR-8.5).
   */
  constructor(private readonly timeoutMs: number = APPROVAL_TIMEOUT_MS) {}

  get all(): readonly Proposal[] {
    return this.proposals;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.find((p) => p.id === id);
  }

  /** Proposals still occupying a slot under the FR-0 limit. */
  get open(): Proposal[] {
    return this.proposals.filter(
      (p) => p.status === "pending" || p.status === "awaiting_approval",
    );
  }

  /** The one a human is being asked to decide right now, if any. */
  get awaitingApproval(): Proposal | undefined {
    return this.proposals.find((p) => p.status === "awaiting_approval");
  }

  create(input: {
    createdAt: number;
    hypothesis: string;
    service: ServiceName;
    action: ActionKind;
    parameters: RemediationParams;
    evidenceIds: string[];
  }): { ok: true; proposal: Proposal } | { ok: false; error: string } {
    if (this.open.length >= MAX_PENDING_PROPOSALS) {
      return {
        ok: false,
        error:
          `At most ${MAX_PENDING_PROPOSALS} proposals may be open at once, and there are already ` +
          `${this.open.length}: ${this.open.map((p) => p.id).join(", ")}. Execute or abandon one first.`,
      };
    }

    const proposal: Proposal = {
      id: `prop_${String(this.nextId++).padStart(4, "0")}`,
      createdAt: input.createdAt,
      status: "pending",
      hypothesis: input.hypothesis,
      service: input.service,
      action: input.action,
      parameters: input.parameters,
      evidenceIds: [...input.evidenceIds],
      blastRadius: BLAST_RADIUS[input.action],
      approvalDeadline: null,
      decidedAt: null,
      decisionReason: null,
      actionId: null,
    };
    this.proposals.push(proposal);
    return { ok: true, proposal };
  }

  private move(proposal: Proposal, to: ProposalStatus, simNow: number): boolean {
    if (!canTransition(proposal.status, to)) return false;
    proposal.status = to;
    if (to !== "approved" && to !== "executed") proposal.decidedAt = simNow;
    return true;
  }

  /**
   * Move a `pending` proposal to `awaiting_approval` and hand back the promise the
   * agent's call blocks on — FR-8.1.
   *
   * Refuses any other status, including `awaiting_approval` itself: a second concurrent
   * call for the same proposal is refused rather than queued (FR-8.4), because queueing
   * would let one human decision settle two calls.
   */
  requestApproval(
    id: string,
    simNow: number,
    options: { signal?: AbortSignal; onStateChange?: () => void } = {},
  ): { ok: true; settled: Promise<Settlement> } | { ok: false; error: string } {
    const proposal = this.get(id);
    if (!proposal) {
      const known = this.proposals.map((p) => p.id).join(", ") || "none yet";
      return { ok: false, error: `Unknown proposal_id ${JSON.stringify(id)}. Proposals: ${known}.` };
    }
    if (proposal.status !== "pending") {
      return {
        ok: false,
        error:
          `Proposal ${id} is ${proposal.status} and cannot be executed. Only a pending proposal ` +
          `can be executed, and each may be executed once.`,
      };
    }

    this.move(proposal, "awaiting_approval", simNow);
    proposal.approvalDeadline = Date.now() + this.timeoutMs;
    options.onStateChange?.();

    const settled = new Promise<Settlement>((resolve) => {
      let done = false;
      const settle = (settlement: Settlement) => {
        if (done) return;
        done = true;

        const timer = this.timers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(id);
        this.settlers.delete(id);

        resolve(settlement);
      };

      this.settlers.set(id, settle);

      this.timers.set(
        id,
        setTimeout(() => {
          if (this.move(proposal, "expired", simNow)) {
            settle({ kind: "expired" });
            options.onStateChange?.();
          }
        }, this.timeoutMs),
      );

      // FR-8.8 — an aborting caller cancels the approval and nothing is applied.
      if (options.signal) {
        if (options.signal.aborted) {
          this.move(proposal, "cancelled", simNow);
          settle({ kind: "cancelled", reason: "the calling agent aborted the request" });
        } else {
          options.signal.addEventListener(
            "abort",
            () => {
              if (this.move(proposal, "cancelled", simNow)) {
                settle({ kind: "cancelled", reason: "the calling agent aborted the request" });
                options.onStateChange?.();
              }
            },
            { once: true },
          );
        }
      }
    });

    return { ok: true, settled };
  }

  /** The human's decision. Only ever reachable from `awaiting_approval` (FR-8.1a). */
  approve(id: string, simNow: number): boolean {
    const proposal = this.get(id);
    if (!proposal || !this.move(proposal, "approved", simNow)) return false;
    proposal.decidedAt = simNow;
    this.settlers.get(id)?.({ kind: "approved" });
    return true;
  }

  deny(id: string, reason: string, simNow: number): boolean {
    const proposal = this.get(id);
    if (!proposal || !this.move(proposal, "denied", simNow)) return false;
    proposal.decisionReason = reason;
    this.settlers.get(id)?.({ kind: "denied", reason });
    return true;
  }

  /** Records the applied action once execution has actually happened. */
  markExecuted(id: string, actionId: string, simNow: number): boolean {
    const proposal = this.get(id);
    if (!proposal || !this.move(proposal, "executed", simNow)) return false;
    proposal.actionId = actionId;
    proposal.decidedAt = simNow;
    return true;
  }

  /**
   * FR-8.0 — a scenario switch or a human resolving the incident cancels what is open.
   * A proposal about an incident that no longer exists cannot meaningfully be approved.
   */
  cancelOpen(reason: string, simNow: number): void {
    for (const proposal of this.open) {
      if (this.move(proposal, "cancelled", simNow)) {
        proposal.decisionReason = reason;
        this.settlers.get(proposal.id)?.({ kind: "cancelled", reason });
      }
    }
  }

  /** Clears timers so a discarded store cannot fire into a world that no longer exists. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.settlers.clear();
  }
}
