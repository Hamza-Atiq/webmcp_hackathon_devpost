# 004 — Coverage matrix

Every one of the 92 `FR` clauses in `spec.md` and all 16 acceptance criteria, against what the code
actually does. Checked by reading the code, not by recall.

**This file is re-checked at the end of every phase.** Its purpose is that nothing falls off the
end quietly: scope is never reduced, so anything not yet built is *sequenced*, and must appear here
with the phase that will build it.

Status: **done** · **partial** (works, incomplete against the clause) · **open** (not started).

_Last checked: 2 September 2026, after P3 shipped the read-only tool layer (`2b2a763`)._

---

## Live gaps — in the shipped product now, not phase deferrals

**All four are now closed.** G1, G2 and G4 in `5833b98`; G3 in `2b2a763`; and the fourth
prerequisite `003` §1 named — action ids and before-snapshots, FR-10.1a — in `5bb0726`. The table
is kept as written because the reasoning is what makes the next audit worth doing.

Three further defects were found in this phase, none of them by a test. All three passed a green
suite and failed the moment the tool layer was driven on a live page: the simulation froze in a
hidden tab (`requestAnimationFrame` is throttled to nothing when the page is not visible),
`search_logs` dropped the correlation id that links logs to traces, and the runbook search
returned the least specific match first. Fixed in `741e940`, with `5b5e76a` correcting the
bounding order in `003` that caused the second. **The standing rule earned its keep: nothing is
finished until it has been seen working.**

| # | Clause | What is wrong | Fix |
|---|---|---|---|
| **G1** | FR-2.4a | `api-gateway`, `payment-service` and `inventory-service` have **no deployment history at all**, so `rollback_deployment` against them would be refused for want of a target. FR-2.4a says it must be executable on every service and "never refused for want of a target" — this is the trap scenarios 3 and 5 depend on. | Seed a prior deployment for the three missing services. |
| **G2** | FR-5.2 | The manual scenario trigger does not exist and was **not assigned to any phase**. The environment only starts a scenario on its own at T+20s. A judge with three minutes cannot skip the wait. | Build with the scenario selector. |
| **G3** | FR-12.3 | Runbooks and ownership now exist in the engine but are **not browsable in the interface**. FR-12.3 requires *all* FR-4 evidence to be browsable with no agent present. Adding them to the engine without the UI created this gap. | Two more evidence tabs. |
| **G5** | FR-12.3 × FR-4.1 | 12.3 was recorded **done** on the strength of five evidence tabs, but metrics are an FR-4 source too and the interface drew only two of their signals. Request rate, p50, p95, CPU, memory and replica count were reachable **only through `get_metrics`** — the agent could see the traffic the environment was serving and a human could not. Found by a reader asking where the 450 rps was on screen, not by the audit. | A throughput chart and a vitals strip. |
| **G4** | FR-3.4 | Speed independence holds by construction (fixed tick size, driver only varies tick count) but has **never been verified**. AC-12 depends on it. | A test that runs the same scenario at 1x and 60x and compares the evidence. |

---

## FR-1 — Simulated environment · **done**

| Clause | Status | Note |
|---|---|---|
| 1.1 five services, dependency graph | done | `world.ts` |
| 1.2 ~450 rps, bounded variation | done | measured 450 ±10% |
| 1.3 computed, never from a fixture | done | guard: no fixture data exists |
| 1.4 config change acts through simulation | done | no scenario-keyed lookup anywhere |
| 1.5 seeded, replayable | done | `determinism-guard.test.ts` + replay tests |

## FR-2 — Scenario library · **partial**

| Clause | Status | Phase |
|---|---|---|
| 2.1 five scenarios selectable | partial — s1 only | P5 |
| 2.2 one active, switching resets | open | P5 |
| 2.3 each defines mechanism, evidence, runbook, fix | partial — runbooks for all five exist; mechanisms 2–5 do not | P5 |
| 2.4 scenarios 3 and 5 have no deploy in window | open | P5 |
| **2.4a rollback always executable** | **violated — see G1** | now |
| 2.4b scenario 4 inverse trap | open | P5 |
| 2.4c no fix works for more than two scenarios | open — verified by the matrix test | P5 |
| 2.5 no tool discloses the scenario | done so far | leak-tested in runbooks; must hold for every tool in P3 |

## FR-3 — Simulated clock · **partial**

| Clause | Status | Phase |
|---|---|---|
| 3.1 one clock, no wall-clock in business logic | done | guard test |
| 3.2 1x / 10x / 60x, changeable live | done | |
| 3.3 time and multiplier always visible | done | |
| **3.4 speed changes rate, never values** | **untested — see G4** | now |
| 3.4a fixed-size ticks | done | |
| 3.5 approval timeout never scales with speed | open | P4 |

## FR-4 — Evidence sources · **partial**

| Clause | Status | Phase |
|---|---|---|
| 4.1 metrics, queryable by window | done — `get_metrics` for the agent; throughput charted and the remaining signals in the vitals strip for a human (G5) | |
| 4.2 logs with correlation id, filterable | done | |
| 4.3 traces, span trees | done | |
| 4.4 deployments with author and diff | done | |
| 4.5 runbooks | done | |
| 4.6 ownership | done | |
| 4.7 incident record | done | |
| 4.8 no single source is sufficient | holds for s1 | re-verify per scenario in P5 |

## FR-5 — Incident lifecycle · **partial**

| Clause | Status | Phase |
|---|---|---|
| 5.1 healthy window before onset | done | T+20s simulated |
| **5.2 manual trigger** | **open, unassigned — see G2** | now |
| 5.3 opens automatically with severity | done | |
| 5.4 status progression | done | |
| 5.5 status changes, tool calls and remediations on the timeline | partial — status and remediation on the timeline; tool calls are in the audit trail | P6 |

## FR-6 — Read-only tools · **done**

| Clause | Status | Note |
|---|---|---|
| 6.1 every response carries citable ids | done | all twelve; metrics mint `met_*` per response |
| 6.2 `untrustedContentHint` on log content | done | annotation **and** `content_trust` in the body |
| 6.3 bounded output | done | ceiling asserted at maximum parameters for every tool |
| 6.4 instructive refusals | done | unknown values name the valid ones; an aged-out trace is distinguished from one that never existed |

All twelve Class A tools ship in `src/mcp/tools/readonly.ts` as plain functions, bound by
`register.ts`. Verified live through the console harness; the DevTools panel check is still owed
and needs the Chrome flag.

## FR-7 — Proposal and evidence validation · **open** → P4
## FR-8 — Approval gate · **open** → P4

Twelve clauses including the full state machine, the blocking promise, the 60-second wall-clock
timeout, abort, denial with reason, and concurrent proposals. The largest single block of
unstarted work in the spec.

## FR-9 — Remediation actions · **partial**

| Clause | Status | Phase |
|---|---|---|
| 9.1 effects apply over time, never instantly | done for rollback | recovery-shape tests |
| 9.2 outcome matrix | open | P5 |
| 9.2a pool is shared, not per-replica | done | |
| 9.3 restart is temporary relief in S2 | open | P5 |
| 9.4 scaling worsens S4 | open | P5 |
| 9.4a S4 rollback hits an unrelated deploy | open | P5 |
| 9.5 wrong service, no effect | open | P5 |

## FR-10 — Verification · **done**

| Clause | Status | Note |
|---|---|---|
| 10.1 compares the before-snapshot against now | done | `src/engine/actions.ts` |
| 10.1a every applied action mints an id, human or agent | done | the P2 dashboard rollback included |
| 10.1b `verify_remediation` mutates nothing | done | Class A |
| 10.2 the verdict is measured, not inferred | done | a wrong action reaches the same code path and fails on the signals |
| 10.3 a failure names what is still out of bounds | done | |
| 10.4 `resolved` gated on verification | done | |

Verified live: a human rollback at T+472s minted `act_0001` with error rate 9.28% and p99 3106ms,
and verification at T+583s measured 0.24% and 112ms — verdict `passed`.

## FR-11 — Incident closure · **open** → P6
## FR-12 — Human parity · **partial**

| Clause | Status | Phase |
|---|---|---|
| 12.1 every agent action available to a human | partial — rollback only | P5 |
| 12.2 one implementation, not two | done | UI calls the same engine methods |
| 12.3 all evidence browsable with no agent | **done** — five tabs; runbooks and ownership added in `2b2a763`; the FR-4.1 metric signals added after G5 | |
| 12.4 a human can complete an entire incident | partial — no postmortem yet | P6 |
| 12.5 human actions need no approval | done | |

## FR-13 — Audit trail · **done for Class A**

All ten fields are recorded, for tool calls and dashboard clicks alike, in one trail
(`src/mcp/audit.ts`). FR-13.1a keeps `source` and `actor` separate, and only `source` is
load-bearing: the page cannot tell an agent from a human invoking the same tool by hand in the
DevTools panel, so FR-13.5 keys citability on how a call arrived rather than on a claim the page
cannot verify. FR-13.3 (refusals recorded with their reason) and FR-13.4 (which tools have gone
unused) are both covered by tests.

Class B and C operations join the same trail in P4; the interface renders it as a flat list and
gets its unified source/actor treatment in P6.

## FR-14 — Tool registration · **partial** → P3

| Clause | Status |
|---|---|
| 14.1 `document.modelContext.registerTool` | **done and seen** — 3 Sept 2026, Chrome 152 with `#enable-webmcp-testing`: the header reads WebMCP connected and DevTools → Application → WebMCP lists all fourteen tools |
| 14.2 top-level only | done — no iframes |
| 14.3 single page, no navigation | done — no router |
| 14.4 registered exactly once | done — module-scope guard, outside React |
| 14.5 typed schemas and validation | done — JSON Schema per tool in `schemas.ts`, validation in every handler |
| 14.6 works without WebMCP | done — verified live |

## FR-15 — Reset and determinism · **partial**

| Clause | Status |
|---|---|
| 15.1 reset control | done |
| 15.2 reset clears everything | partial — proposals do not exist yet |
| 15.3 no state carries over | done — reset builds a new engine |
| 15.4 reload equals reset | done |
| 15.5 same actions, same results | done |

---

## Acceptance criteria

| AC | Status |
|---|---|
| AC-1 healthy → incident with correct severity | **done** — verified live, opens SEV-2 at T+02:16 |
| AC-2 evidence agrees with itself | done for s1 — one simulation feeds all sources |
| AC-3 no single-source diagnosis | holds for s1; per-scenario in P5 |
| AC-4 unsupported citations impossible | open — P4 |
| AC-5 nothing acts without a human | open — P4 |
| AC-5a severity is measured, not stored | **done** — asserted against the FR-0 table |
| AC-6 approval genuinely blocks | open — P4 |
| AC-7 wrong fixes fail | open — P5 |
| AC-8 rollback is not universal | open — P5, and blocked on G1 |
| AC-9 correct fixes recover | done for s1 — verified live |
| AC-10 a human alone can do everything | partial — full arc by hand in Chrome, all evidence browsable; postmortem missing |
| AC-11 the trail is complete | partial — all ten fields for Class A; B and C in P4 |
| AC-12 it repeats exactly | **done** — replay and speed independence both tested |
| AC-13 works on both surfaces | open — P7, needs the Chrome flag |
| AC-14 degrades gracefully | **done** — verified live with no WebMCP |
| AC-15 the full arc runs | open — P4 onward |

---

## Changes made that were not in the plan

Recorded here because calibration changes what a judge sees, and the product owner decides them.

| Change | Why | Status |
|---|---|---|
| Trace sampling cut to 0.2% of successes with a 4/second cap on error traces; buffer raised to 3000 | 96% of log correlation ids pointed at evicted traces | **approved 2 Sept 2026** |
| Correlated error logs cut to 1/service/second; routine background 500s no longer logged | correlated failures were 853 of 991 log lines and buried the pool evidence | **approved 2 Sept 2026** |
| Default clock speed 10x rather than 1x | at 1x the incident opens 80 seconds after load, which is too slow for a 3-minute demo | **approved 2 Sept 2026** |

The trace decision was taken deliberately over the alternative of holding 20,000+ traces so that no
citation ever expires. Sampling keeps browser memory bounded, matches how observability actually
works, and leaves an aged-out citation as a real path the tools handle explicitly rather than a
case that never occurs.
