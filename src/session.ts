import { Engine, type ScenarioId } from "./engine";
import { HEALTHY_WINDOW_MS } from "./engine/constants";
import { AuditLog } from "./mcp/audit";
import { EvidenceRegistry } from "./mcp/evidence";
import { ProposalStore } from "./mcp/proposals";

/**
 * One run of the environment: the world, what has been shown to whom, and what anyone did.
 *
 * This lives outside React deliberately. Tools are registered once, before the first
 * render (FR-14.4), so a handler that captured an engine reference at registration would
 * still be reading the *old* world after "Reset environment" — returning evidence from a
 * run that no longer exists. Handlers call `session()` at invocation time instead, so a
 * reset swaps the world under them and the previous run's ids simply stop resolving,
 * which is what FR-7.3 and FR-15.3 both require.
 *
 * The registry and the trail are replaced along with the engine for the same reason: no
 * state carries across a reset.
 */

export interface Session {
  engine: Engine;
  /** Which scenario this run will start. FR-2.2 — exactly one is ever active. */
  scenario: ScenarioId;
  evidence: EvidenceRegistry;
  audit: AuditLog;
  proposals: ProposalStore;
}

function create(scenario: ScenarioId): Session {
  return {
    scenario,
    /** FR-5.1 — healthy for a fixed window, then the scenario begins on its own. */
    engine: new Engine(undefined, { autoStart: { id: scenario, atMs: HEALTHY_WINDOW_MS } }),
    evidence: new EvidenceRegistry(),
    audit: new AuditLog(),
    proposals: new ProposalStore(),
  };
}

let current: Session = create("s1");

const listeners = new Set<() => void>();

export function session(): Session {
  return current;
}

/**
 * FR-2.2 — selecting another scenario resets the environment to a healthy T+0.
 *
 * Not "switches the running world to a different failure": the healthy window has to be
 * lived through again, because the twenty seconds before an incident are evidence too,
 * and an agent handed a world that was already broken cannot tell what changed.
 */
export function resetSession(scenario: ScenarioId = current.scenario): void {
  /*
   * Cancellation comes first, and this is not tidiness. `dispose` drops the settler for
   * every waiting proposal, so a reset while an agent sat blocked on
   * `execute_remediation` would leave that call hanging for the life of the page: the
   * prompt is gone, no click can ever arrive, and the timer that would have expired it
   * has just been cleared. Cancelling settles those calls as `cancelled` first, which is
   * what FR-8.1's "settled by exactly one of four events" requires to stay true across a
   * reset (FR-15.2, FR-15.3).
   */
  cancelOpenProposals("the environment was reset");
  current.proposals.dispose();
  current = create(scenario);
  notifySession();
}

/**
 * FR-8.0 — an open proposal is a question about an incident.
 *
 * When that incident is resolved, or the world moves out from under it, the question can
 * no longer be answered honestly: approving it would apply a remediation to a situation
 * nobody diagnosed. Cancelling settles the agent's blocked call with a reason instead of
 * leaving a prompt on screen for an incident that is over.
 *
 * It lives here rather than in the engine because the engine has no knowledge of
 * proposals and should keep none — and it lives outside React because the agent-facing
 * closure tools in P6 must reach the same code the dashboard's controls do.
 */
export function cancelOpenProposals(reason: string): void {
  if (current.proposals.open.length === 0) return;
  current.proposals.cancelOpen(reason, current.engine.world.nowMs);
  notifySession();
}

/**
 * Called after any operation that the interface should re-render for — including tool
 * calls, which arrive from outside React and would otherwise leave the activity log
 * showing nothing while an agent worked.
 */
export function notifySession(): void {
  for (const listener of listeners) listener();
}

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
