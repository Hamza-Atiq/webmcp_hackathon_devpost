import { Engine } from "./engine";
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
  evidence: EvidenceRegistry;
  audit: AuditLog;
  proposals: ProposalStore;
}

function create(): Session {
  return {
    /** FR-5.1 — healthy for a fixed window, then the scenario begins on its own. */
    engine: new Engine(undefined, { autoStart: { id: "s1", atMs: HEALTHY_WINDOW_MS } }),
    evidence: new EvidenceRegistry(),
    audit: new AuditLog(),
    proposals: new ProposalStore(),
  };
}

let current: Session = create();

const listeners = new Set<() => void>();

export function session(): Session {
  return current;
}

export function resetSession(): void {
  /*
   * Timers are cleared before the store is dropped. An approval timer from the previous
   * run would otherwise fire into a world that no longer exists and expire a proposal
   * nobody can see (FR-15.2, FR-15.3).
   */
  current.proposals.dispose();
  current = create();
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
