import { nextId, type World } from "../engine/world";
import type { EvidenceSource } from "../engine";

/**
 * The evidence registry — FR-6.1, FR-7.3, FR-13.5.
 *
 * Every read-only response lists the ids of the records it returned, and this records
 * them against the source that asked. It is what makes FR-7 enforceable in P4: a
 * proposal citing an id that never appeared in a WebMCP response, in this run, is
 * refused — not because the id looks wrong, but because nobody ever showed it to the
 * agent.
 *
 * The registry lives for exactly one run. A new environment gets a new registry, so an
 * id from a previous run cannot support a citation in this one (FR-7.3, FR-15.3).
 */

export type Channel = "webmcp" | "ui";

export interface EvidenceEntry {
  id: string;
  source: EvidenceSource;
  /** Simulated ms at which the id was first returned. */
  simMs: number;
  /** The tool that first returned it. */
  tool: string;
  /**
   * The arguments of that call. A minted metric id has no record behind it to look up,
   * and FR-7.6 requires cited evidence to appear in readable form — "met_0004" tells a
   * human nothing, "get_metrics p99 checkout-service" tells them what the agent looked at.
   */
  args?: string;
  /**
   * Which channels have seen this id. Only a WebMCP call makes an id citable
   * (FR-13.5): records a human browsed in the interface were never returned to the
   * agent and cannot support the agent's citation.
   */
  channels: Set<Channel>;
}

export class EvidenceRegistry {
  private readonly byId = new Map<string, EvidenceEntry>();

  /**
   * Note that `ids` were returned to `channel` by `tool`.
   *
   * The source of each id is read from its prefix rather than declared by the caller, so
   * a tool cannot mislabel what it returned and satisfy FR-4.8 with two ids of the same
   * kind dressed as two sources.
   */
  record(
    ids: readonly string[],
    meta: { channel: Channel; tool: string; simMs: number; args?: string },
  ): void {
    for (const id of ids) {
      const existing = this.byId.get(id);
      if (existing) {
        existing.channels.add(meta.channel);
        continue;
      }
      const source = sourceOf(id);
      if (source === null) continue;
      this.byId.set(id, {
        id,
        source,
        simMs: meta.simMs,
        tool: meta.tool,
        args: meta.args,
        channels: new Set<Channel>([meta.channel]),
      });
    }
  }

  entry(id: string): EvidenceEntry | undefined {
    return this.byId.get(id);
  }

  /** Was this id returned to an agent in this run? The FR-7 gate. */
  citable(id: string): boolean {
    return this.byId.get(id)?.channels.has("webmcp") ?? false;
  }

  /**
   * The distinct sources behind a set of ids, counting only citable ones.
   * FR-4.8 and FR-7.2 require support from more than one *kind* of evidence, which is
   * a different question from more than one id.
   */
  citableSources(ids: readonly string[]): Set<EvidenceSource> {
    const sources = new Set<EvidenceSource>();
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (entry && entry.channels.has("webmcp")) sources.add(entry.source);
    }
    return sources;
  }

  get size(): number {
    return this.byId.size;
  }

  all(): EvidenceEntry[] {
    return [...this.byId.values()];
  }
}

/**
 * Which evidence source an id belongs to, read from its prefix.
 *
 * One place, rather than each tool declaring the source of the ids it returns: the
 * prefixes are already the contract (spec 003 §5), and a tool that returned ids labelled
 * with the wrong source would quietly satisfy FR-4.8's "more than one source" rule with
 * two of the same kind.
 */
const PREFIXES: Record<string, EvidenceSource> = {
  svc: "services",
  met: "metrics",
  log: "logs",
  trc: "traces",
  dep: "deployments",
  rb: "runbooks",
  own: "ownership",
  inc: "incident",
};

export function sourceOf(id: string): EvidenceSource | null {
  const prefix = id.slice(0, id.indexOf("_"));
  return PREFIXES[prefix] ?? null;
}

/**
 * Mint a series id for a metrics response — spec 003 §5.
 *
 * Metrics are the one source with no natural record id, and FR-6.1 admits no exception,
 * so a response mints one and the registry stores what it covered. The rejected
 * alternative was deriving the id from the query: two agents issuing the same query in
 * different runs would produce the same id, which would let a proposal cite evidence
 * from a previous run and defeat FR-7.3 exactly.
 */
export function mintSeriesId(world: World): string {
  return nextId(world, "met");
}
