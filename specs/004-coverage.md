# 004 — Coverage matrix

Every one of the 92 `FR` clauses in `spec.md` and all 16 acceptance criteria, against what the code
actually does. Checked by reading the code, not by recall.

**This file is re-checked at the end of every phase.** Its purpose is that nothing falls off the
end quietly: scope is never reduced, so anything not yet built is *sequenced*, and must appear here
with the phase that will build it.

Status: **done** · **partial** (works, incomplete against the clause) · **open** (not started).

_Last checked: 2 September 2026, after P3 groundwork (`b0c14a7`)._

---

## Live gaps — in the shipped product now, not phase deferrals

These four are not "later work". They are clauses the current build contradicts or has left
unassigned, found by this audit.

| # | Clause | What is wrong | Fix |
|---|---|---|---|
| **G1** | FR-2.4a | `api-gateway`, `payment-service` and `inventory-service` have **no deployment history at all**, so `rollback_deployment` against them would be refused for want of a target. FR-2.4a says it must be executable on every service and "never refused for want of a target" — this is the trap scenarios 3 and 5 depend on. | Seed a prior deployment for the three missing services. |
| **G2** | FR-5.2 | The manual scenario trigger does not exist and was **not assigned to any phase**. The environment only starts a scenario on its own at T+20s. A judge with three minutes cannot skip the wait. | Build with the scenario selector. |
| **G3** | FR-12.3 | Runbooks and ownership now exist in the engine but are **not browsable in the interface**. FR-12.3 requires *all* FR-4 evidence to be browsable with no agent present. Adding them to the engine without the UI created this gap. | Two more evidence tabs. |
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
| 4.1 metrics, queryable by window | partial — stored and charted; no query API | P3 |
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
| 5.5 status changes, tool calls and remediations on the timeline | partial — status and remediation yes, tool calls not yet | P3 |

## FR-6 — Read-only tools · **open** → P3

11 tools, output bounds, evidence ids, `untrustedContentHint`. Contracts fixed in `003`.

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

## FR-10 — Verification · **open** → P3/P4

`verify_remediation` is Class A and belongs to P3; the action ids and before-snapshots it needs
(FR-10.1a) are specified in `003` and not yet built. FR-10.4 (`resolved` gated on verification) is
**done** in the engine already.

## FR-11 — Incident closure · **open** → P6
## FR-12 — Human parity · **partial**

| Clause | Status | Phase |
|---|---|---|
| 12.1 every agent action available to a human | partial — rollback only | P5 |
| 12.2 one implementation, not two | done | UI calls the same engine methods |
| **12.3 all evidence browsable with no agent** | **partial — see G3** | now |
| 12.4 a human can complete an entire incident | partial — no postmortem yet | P6 |
| 12.5 human actions need no approval | done | |

## FR-13 — Audit trail · **partial** → P3

Five of the ten required fields are recorded. Missing: `duration_ms`, `side_effect_class`,
`status`, and `kind` as a first-class field. FR-13.4 (which tools have gone unused) and FR-13.5
(only `source: webmcp` counts as evidence) are not started.

## FR-14 — Tool registration · **partial** → P3

| Clause | Status |
|---|---|
| 14.1 `document.modelContext.registerTool` | open — the registration hook exists and registers nothing |
| 14.2 top-level only | done — no iframes |
| 14.3 single page, no navigation | done — no router |
| 14.4 registered exactly once | done — module-scope guard, outside React |
| 14.5 typed schemas and validation | open |
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
| AC-10 a human alone can do everything | partial — full arc run by hand in Chrome; postmortem missing |
| AC-11 the trail is complete | partial — P3 |
| AC-12 it repeats exactly | partial — replay tested, speed independence not (G4) |
| AC-13 works on both surfaces | open — P7, needs the Chrome flag |
| AC-14 degrades gracefully | **done** — verified live with no WebMCP |
| AC-15 the full arc runs | open — P4 onward |

---

## Changes made that were not in the plan

Recorded here because calibration changes what a judge sees, and the product owner decides them.

| Change | Why | Status |
|---|---|---|
| Trace sampling cut to 0.2% of successes with a 4/second cap on error traces; buffer raised to 3000 | 96% of log correlation ids pointed at evicted traces | **awaiting sign-off** |
| Correlated error logs cut to 1/service/second; routine background 500s no longer logged | correlated failures were 853 of 991 log lines and buried the pool evidence | **awaiting sign-off** |
| Default clock speed 10x rather than 1x | at 1x the incident opens 80 seconds after load, which is too slow for a 3-minute demo | **awaiting sign-off** |
