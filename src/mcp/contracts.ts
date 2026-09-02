/**
 * The response envelope every tool returns, and the refusals it returns instead.
 *
 * One shape for every tool, success and failure alike (spec 003 §4). A tool never
 * throws: an exception reaches an agent as a transport-level failure with no guidance
 * in it, which teaches the model nothing about what to do differently.
 */

export interface Bounding {
  /** Set only when records or fields were dropped — spec 003 §6. */
  truncated: true;
  returned_count: number;
  total_count: number;
  /** What the caller can pass to get a smaller answer. Never generic. */
  narrow_by: string;
}

export interface ToolOk<T = unknown> {
  ok: true;
  data: T;
  /**
   * The ids of the records in this response, in a form citable as evidence (FR-6.1).
   * The registry records them against the calling source; a proposal citing an id that
   * never appeared here, in this run, from a WebMCP call, is refused in P4.
   */
  evidence_ids: string[];
  truncated?: true;
  returned_count?: number;
  total_count?: number;
  narrow_by?: string;
  /** FR-6.2 — set by tools returning text that originated in request data. */
  content_trust?: "untrusted";
}

export interface ToolErr {
  ok: false;
  error: string;
}

export type ToolResult<T = unknown> = ToolOk<T> | ToolErr;

export function ok<T>(data: T, evidenceIds: string[], bounding?: Bounding): ToolOk<T> {
  return bounding ? { ok: true, data, evidence_ids: evidenceIds, ...bounding }
                  : { ok: true, data, evidence_ids: evidenceIds };
}

/**
 * Refusals name what was wrong *and* what to do instead.
 *
 * The reader is a model that cannot see the screen, so "invalid input" is a defect
 * rather than a terse style (spec 003 §4). Every helper below is shaped to make the
 * instructive version the easy one to write.
 */
export function refuse(error: string): ToolErr {
  return { ok: false, error };
}

export function unknownValue(kind: string, got: unknown, valid: readonly string[]): ToolErr {
  return refuse(`Unknown ${kind} ${JSON.stringify(got)}. Valid values: ${valid.join(", ")}.`);
}

export function missingParam(name: string, example: string): ToolErr {
  return refuse(`Missing required parameter "${name}". Example: ${example}`);
}

/** Serialised form — one JSON text content block per spec 003 §4. */
export function toText(result: ToolResult): string {
  return JSON.stringify(result);
}

/**
 * Out-of-range numbers are clamped rather than refused, and the response says so.
 *
 * An agent asking for 500 log lines wants log lines; the useful answer is 50 of them
 * plus a note (spec 003 §7). Returns the clamped value and the note, if any.
 */
export function clampLimit(
  requested: unknown,
  fallback: number,
  max: number,
): { value: number; note: string | null } {
  if (requested === undefined || requested === null) return { value: fallback, note: null };

  const n = Number(requested);
  if (!Number.isFinite(n) || n < 1) return { value: fallback, note: null };
  if (n > max) {
    return {
      value: max,
      note: `limit was clamped from ${Math.floor(n)} to the maximum of ${max}.`,
    };
  }
  return { value: Math.floor(n), note: null };
}
