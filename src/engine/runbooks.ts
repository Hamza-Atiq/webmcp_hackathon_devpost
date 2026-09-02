import type { ServiceName } from "./types";

/**
 * The runbook library — FR-4.5.
 *
 * Two rules govern what is written here, and both are load-bearing.
 *
 * **A runbook names a failure mode, never this incident's culprit.** Scenario 1's runbook is
 * titled "Database connection pool exhaustion" and tells you how to look: read the waiter counts,
 * compare acquire time against query time, then check recent configuration changes. It never
 * mentions `DB_POOL_MAX`, the deployment, or the pool size. So it makes the diagnosis *findable*
 * while still requiring the agent to correlate traces with the deployment diff — FR-4.8 holds,
 * and FR-2.5 is not violated by the back door.
 *
 * **The library covers failure modes that are not active.** If it held one runbook, retrieving it
 * would identify the scenario outright and `get_runbook` would be an oracle. Six entries covering
 * all five mechanisms plus a general triage procedure mean a search returns plausible neighbours,
 * and the agent must still decide which one its evidence supports.
 *
 * Runbooks are reference material, not observations: their ids are stable across every run.
 */

export interface Runbook {
  id: string;
  title: string;
  /** What an engineer would notice. Matched against a caller's `symptom` query. */
  symptoms: string[];
  /** The procedure. Written as instructions to a person, because that is what a runbook is. */
  steps: string[];
  /** Signals worth pulling while working this runbook. */
  signals: string[];
  /** Services this procedure is written for, or "any". */
  appliesTo: ServiceName[] | "any";
}

export const RUNBOOKS: Runbook[] = [
  {
    id: "rb_latency_triage",
    title: "Latency investigation: where to start",
    symptoms: ["latency", "slow", "p99", "response time", "timeout", "general"],
    steps: [
      "Identify which service is degraded. Work on the one whose own signals moved, not the one complaining loudest — a caller looks broken when its dependency is.",
      "Compare p50 against p99. If p50 is flat while p99 climbs, only a subset of requests is affected; look for a shared resource rather than a code path everyone takes.",
      "Check error rate and saturation alongside latency. Latency alone rarely identifies a cause.",
      "Open a slow trace and find which span holds the time.",
      "Check what changed: deployments, feature flags and running jobs, in that order.",
    ],
    signals: ["p50", "p99", "error rate", "cpu", "memory"],
    appliesTo: "any",
  },
  {
    id: "rb_pool_exhaustion",
    title: "Database connection pool exhaustion",
    symptoms: [
      "connection pool",
      "pool exhausted",
      "waiters",
      "acquire",
      "database latency",
      "504",
      "gateway timeout",
    ],
    steps: [
      "Search the service's error logs for pool saturation lines and note the waiter count. A queue that is not draining points at capacity, not at the database.",
      "Open a slow trace and compare the connection-acquire span against the query span. If acquire dominates while the query itself stays fast, the database is healthy and the pool in front of it is not.",
      "Confirm p50 is roughly unchanged. Only requests that touch the database queue, so the typical request is unaffected — a flat p50 with a climbing p99 is consistent with this failure mode.",
      "Review recent configuration changes affecting pool sizing on the affected service, including changes made for unrelated reasons such as memory tuning.",
      "Restore the pool to a size that covers peak concurrent database demand. Adding replicas does not help when the pool is shared at the service level.",
    ],
    signals: ["p99", "error rate", "waiters", "connections in use"],
    appliesTo: ["checkout-service", "payment-service", "inventory-service", "user-service"],
  },
  {
    id: "rb_memory_pressure",
    title: "Memory growth and heap pressure",
    symptoms: ["memory", "heap", "oom", "garbage collection", "gradual degradation", "leak"],
    steps: [
      "Plot memory over a long window. A leak climbs steadily across hours and does not fall between traffic troughs.",
      "Check whether degradation tracks uptime rather than traffic. A process that worsens the longer it runs is holding something it should release.",
      "Correlate the start of the climb with a deployment. Note that restarting clears the symptom without addressing the cause, so recovery after a restart is not evidence that the restart fixed it.",
      "Prefer reversing the change that introduced the growth over restarting on a schedule.",
    ],
    signals: ["memory", "p99", "restarts"],
    appliesTo: "any",
  },
  {
    id: "rb_dependency_timeout",
    title: "External dependency latency and timeouts",
    symptoms: ["dependency", "third party", "provider", "external", "upstream timeout", "vendor"],
    steps: [
      "Find the span representing the outbound call and check whether the time is spent waiting on it rather than in your own handler.",
      "Check whether the affected code path is gated behind a feature flag; a recently enabled flag can introduce a dependency without any deployment.",
      "Confirm no deployment correlates with the onset. A degradation with no deploy behind it points outside your system.",
      "Consider bypassing the dependency at the flag rather than rolling back code that did not change.",
    ],
    signals: ["p99", "error rate", "external call duration"],
    appliesTo: "any",
  },
  {
    id: "rb_lock_contention",
    title: "Database lock contention and slow queries",
    symptoms: ["lock", "contention", "migration", "slow query", "blocked", "schema"],
    steps: [
      "Check for long-running jobs holding locks — migrations, backfills, bulk updates — independently of application deployments.",
      "Note whether query latency rises with the number of concurrent connections. Contention worsens as more workers compete for the same locks.",
      "Be careful adding replicas. More replicas open more connections, which increases contention rather than relieving it.",
      "If the application reads through a schema being migrated, stopping that read path releases the contention. A migration already in flight cannot be undone by redeploying application code.",
    ],
    signals: ["query latency", "connections in use", "p99"],
    appliesTo: "any",
  },
  {
    id: "rb_capacity_saturation",
    title: "Saturation and insufficient headroom",
    symptoms: ["capacity", "saturation", "cpu", "traffic spike", "load", "headroom"],
    steps: [
      "Compare request rate against the recent baseline. A step change in traffic with no change in your system is a capacity problem, not a defect.",
      "Check CPU utilisation per replica. Latency rises sharply as utilisation approaches its limit, well before requests begin failing.",
      "Confirm no deployment or flag change correlates with the onset.",
      "Add capacity, or reduce the load reaching the service. Rolling back code that did not change will not help.",
    ],
    signals: ["requests", "cpu", "p99", "error rate"],
    appliesTo: "any",
  },
];

/**
 * Find runbooks matching a free-text symptom and/or a service.
 *
 * Deliberately a keyword match over titles and symptom lists rather than anything cleverer: the
 * agent should be able to predict what a query will return, and a fuzzy ranker that silently
 * reorders results would make the evidence trail harder to reason about, not easier.
 */
export function findRunbooks(query?: string, service?: ServiceName): Runbook[] {
  const needle = query?.trim().toLowerCase();

  const matches = RUNBOOKS.filter((runbook) => {
    if (service && runbook.appliesTo !== "any" && !runbook.appliesTo.includes(service)) {
      return false;
    }
    if (!needle) return true;

    return (
      runbook.title.toLowerCase().includes(needle) ||
      runbook.symptoms.some((s) => s.includes(needle) || needle.includes(s))
    );
  });

  // A query that matches nothing still returns the general procedure: an on-call engineer with an
  // unrecognised symptom needs a starting point, not an empty result.
  if (matches.length === 0) {
    return RUNBOOKS.filter((r) => r.id === "rb_latency_triage");
  }

  return matches;
}

export function runbookById(id: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.id === id);
}
