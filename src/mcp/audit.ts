/**
 * The unified operation trail — FR-13.
 *
 * One log for everything anyone did, whether they clicked it or called it. Ten fields
 * per operation (spec 003 §10), and two of them are easy to conflate:
 *
 * **`source` and `actor` are not redundant** (FR-13.1a). A human invoking a tool by
 * hand from the DevTools WebMCP panel is `source: webmcp, actor: human`. The page
 * cannot tell that apart from an agent and must not pretend it can — so `actor` is
 * what the caller declared, and `source` is how the call physically arrived. A
 * dashboard click is `source: ui, actor: human` and is not a tool call at all.
 *
 * Only `source: webmcp` entries can support an agent's citation (FR-13.5), which is
 * why the distinction is recorded rather than flattened into "who did it".
 */

export type AuditKind = "tool_call" | "ui_action";
export type AuditSource = "webmcp" | "ui";
export type AuditActor = "human" | "agent";
export type AuditStatus = "ok" | "refused" | "error";

/** FR-0 tool classes: A reads, B proposes, C changes the environment. */
export type SideEffectClass = "A" | "B" | "C";

export interface AuditEntry {
  id: number;
  /**
   * Simulated ms. The trail is read against the incident timeline and the evidence,
   * which are all stamped on the simulated clock; a wall-clock stamp here would be
   * uncorrelatable with everything it sits beside. `duration_ms` is the wall-clock
   * measurement, and is one of only two legitimate uses of real time in the project.
   */
  timestamp: number;
  kind: AuditKind;
  operation: string;
  source: AuditSource;
  actor: AuditActor;
  /** The call's arguments, serialised for display. */
  arguments: string;
  result_summary: string;
  duration_ms: number;
  status: AuditStatus;
  side_effect_class: SideEffectClass;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private nextId = 1;

  add(entry: Omit<AuditEntry, "id">): AuditEntry {
    const recorded: AuditEntry = { ...entry, id: this.nextId++ };
    this.entries.push(recorded);
    return recorded;
  }

  /** Chronological, oldest first. */
  get all(): readonly AuditEntry[] {
    return this.entries;
  }

  /**
   * Tools that have never been called — FR-13.4.
   *
   * Worth showing rather than inferring: what an agent *did not* look at is often the
   * reason a diagnosis went wrong, and it is invisible in a list of what it did.
   */
  unused(registered: readonly string[]): string[] {
    const called = new Set(this.entries.filter((e) => e.kind === "tool_call").map((e) => e.operation));
    return registered.filter((name) => !called.has(name));
  }
}

/** Refused and failed calls are recorded with their reason, never dropped (FR-13.3). */
export function summarise(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
