/**
 * WebMCP tool registration entry point.
 *
 * Called exactly once, from `main.tsx`, BEFORE React renders — never from a
 * component effect. React StrictMode double-invokes effects in development, and
 * `document.modelContext.registerTool` rejects a name that is already registered
 * with an `InvalidStateError`. The symptom of that bug is a *missing tool*, not an
 * obvious crash, so it is worth being structurally impossible. See spec FR-14.4.
 */

let registered = false;

/** FR-14.6 — the app must work normally in a browser with no WebMCP support. */
export function webmcpAvailable(): boolean {
  return typeof document !== "undefined" && "modelContext" in document;
}

export function registerTools(): void {
  if (registered) return;
  registered = true;

  if (!webmcpAvailable()) return;

  // Read-only tools land in P3; proposal, approval and execution in P4.
}
