import { ok, toText, type ToolOk } from "./contracts";

/**
 * Output bounding — spec 003 §6, from FR-0.
 *
 * 1500 characters is a design target, 4000 a hard ceiling. Chrome's tool-security
 * guidance is the source of the first figure; exceeding the second is a bug rather
 * than a degraded mode, and a test asserts every tool at maximum parameters stays
 * under it.
 *
 * **Records are dropped whole.** A half-serialised log line is worse than a missing
 * one: it invites a model to reason from a fragment and gives it no way to tell that
 * is what it is doing. What shrinks first is optional *fields*, in a fixed order the
 * tool declares; only then does the record count come down, and the response says how
 * many of how many it returned.
 */

export const SIZE_TARGET = 1500;
export const SIZE_CEILING = 4000;

export interface BoundInput<T> {
  /** Candidates, ordered by the tool with the most useful first. */
  records: T[];
  /** The tool's record cap from the FR-0 table, after clamping. */
  cap: number;
  /** What the caller can pass to get a smaller answer. Tool-specific, never generic. */
  narrowBy: string;
  /**
   * Optional-field reducers applied in order when the response is over target — trace
   * span children beyond depth 2, then log `correlationId`, then deployment `summary`.
   */
  reducers?: Array<(record: T) => T>;
  /** Builds the `data` payload from the records that survived. */
  data: (records: T[]) => unknown;
  /** Evidence ids for the records that survived (FR-6.1). */
  ids: (records: T[]) => string[];
  /** An extra note for `narrow_by`, such as a clamped limit. */
  note?: string | null;
  /** FR-6.2 — marks a response whose text originated in request data. */
  untrusted?: boolean;
}

export function bounded<T>(input: BoundInput<T>): ToolOk {
  const total = input.records.length;
  const reducers = input.reducers ?? [];
  const capped = input.records.slice(0, input.cap);

  const build = (count: number, reducerCount: number): ToolOk => {
    let view = capped.slice(0, count);
    for (let i = 0; i < reducerCount; i++) view = view.map(reducers[i]!);

    const truncated = view.length < total || reducerCount > 0;
    const notes: string[] = [];
    if (input.note) notes.push(input.note);

    /*
     * Name the constraint that actually bound the answer.
     *
     * Found live: `search_logs({ limit: 10000 })` returned **6** of 600 entries while
     * saying "limit was clamped to the maximum of 50" — true, and not the reason. The
     * size budget is what stopped it at six, and an agent reading only the clamp would
     * conclude six was all that matched, or ask for fifty again and get six again. A
     * bound that misreports itself is worse than a tighter bound.
     */
    if (view.length < capped.length) {
      notes.push(
        `Returned ${view.length} of the ${capped.length} records allowed here: the response is ` +
          `bounded to about ${SIZE_TARGET} characters, and the rest did not fit.`,
      );
    }

    if (truncated) notes.push(input.narrowBy);

    const result = truncated
      ? ok(input.data(view), input.ids(view), {
          truncated: true,
          returned_count: view.length,
          total_count: total,
          narrow_by: notes.join(" "),
        })
      : ok(input.data(view), input.ids(view));

    if (!truncated && notes.length > 0) result.narrow_by = notes.join(" ");
    if (input.untrusted) result.content_trust = "untrusted";
    return result;
  };

  let reducerCount = 0;
  let count = capped.length;

  for (;;) {
    const result = build(count, reducerCount);
    if (toText(result).length <= SIZE_TARGET) return result;

    if (reducerCount < reducers.length) {
      reducerCount += 1;
      continue;
    }
    if (count > 1) {
      count -= 1;
      continue;
    }
    // A single record with every optional field stripped. Returning it over target is
    // honest; the ceiling test is what keeps that from silently becoming 4000 characters.
    return result;
  }
}
