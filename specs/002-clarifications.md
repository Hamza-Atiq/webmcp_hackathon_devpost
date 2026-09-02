# Clarifications — Decisions Log

Phase 3 (Clarify) of the spec-driven workflow. Follows `000-research.md` and `001-system-design.md`.

Every decision here was made by the product owner. Where I would refine or sequence a decision
differently, that is stated openly under **Recommendation** — the decision itself stands.

---

## Settled before the interview

| Decision | Value |
|---|---|
| Framework | React |
| Host | Vercel |
| Scope | All capabilities in `Project_Story.md`. No trimming. |

---

## D1 — Scenario library: five scenarios

Five distinct failure classes, each with its own metric curves, log lines, trace shapes,
deployment history, runbook and remediation path.

| # | Scenario | Failure class | Primary evidence | Fix |
|---|---|---|---|---|
| 1 | Config regression | `checkout-service` DB pool 50 → 5 | Traces + deploy diff | Rollback |
| 2 | Resource exhaustion | `inventory-service` memory leak | Metric trend + restart history | Rollback (restart is temporary relief only) |
| 3 | Dependency failure | `payment-service` external fraud-scoring provider timing out | Trace spans + error logs | Disable `payment_fraud_check_v2` flag |
| 4 | Bad migration | Lock contention on `user-service` DB from a standalone migration job | Slow-query logs + migration record | Disable `user_profile_schema_v2` flag |
| 5 | Capacity | Traffic spike beyond replica headroom | Traffic metrics + saturation | Scale replicas |

**Why this is a strong choice.** Five *different* failure classes means the agent cannot
pattern-match a single answer. Scenario 1's fix is a rollback; scenario 5's is scaling, and
rolling back would achieve nothing. That variety is what proves genuine reasoning rather than a
memorised path, and it exercises all five remediation actions naturally.

**The distribution is deliberate.** No single remediation is the answer to more than two of the five
scenarios: rollback fixes 1 and 2, the feature flag fixes 3 and 4, scaling fixes 5, and neither
restart nor traffic shift ever fully fixes anything. An agent that always reaches for rollback
succeeds at most 40% of the time. Scenario 4 is the sharpest trap of the five: a recent deployment
*does* exist and correlates in time, but it is unrelated to the migration actually causing the
contention, so rolling it back achieves nothing.

**Recommendation.** Build them in the order listed and make each one independently complete.
Scenario 1 is the demo-video scenario and must be flawless; 4 and 5 reuse machinery from 1 and 2,
so they are the cheapest to add last. This is sequencing, not scope reduction — all five ship.

**Design rule this creates.** No tool may ever reveal which scenario is active. Tools expose
symptoms only — never a label like `"scenario": "memory_leak"`. If the agent can read the answer,
the investigation is theatre.

## D2 — Remediation actions: full set of five

| Action | Blast radius | Effect in the engine |
|---|---|---|
| `rollback_deployment` | HIGH | Previous version's config becomes active |
| `restart_service` | MEDIUM | Process state cleared; in-flight requests dropped |
| `scale_replicas` | LOW | Per-replica load drops; capacity rises |
| `disable_feature_flag` | MEDIUM | Code path bypassed; dependency call skipped |
| `shift_traffic` | HIGH | Traffic rerouted away from the unhealthy target |

**Why this is a strong choice.** Different blast radii make the approval card *specific*.
"Approve scaling replicas — cost impact only" and "Approve rolling back all production traffic"
are visibly different decisions. A single generic confirm button would waste the entire
human-in-the-loop idea.

**The real cost.** Each action needs its own recovery model in the engine — restarting clears a
leak but does not fix a config error; scaling helps a capacity problem but not pool starvation.
**Wrong remediations must genuinely fail to fix the incident.** If any action silently resolves
any incident, the agent's diagnosis stops mattering and the whole project collapses. This is the
single most important correctness property in the build.

## D3 — Human parity: full

Every action the agent can propose, a human can also perform directly from the dashboard. All
evidence panels are browsable without an agent.

**Why this is a strong choice.** It is the direct answer to the Execution criterion — "a complete,
coherent product experience, not just a technical proof of concept." A judge who never opens an
agent still sees a working SRE console. It also makes the WebMCP layer read as an *addition to* a
real product rather than the only reason the product exists.

**Recommendation.** Route human actions and agent actions through **the same engine functions**,
never two parallel implementations. The audit log then records both with an `actor` field of
`human` or `agent`, which produces one of the strongest visuals in the project: a single unified
timeline showing exactly who did what, and when.

## D4 — Incident start: fires live

App loads healthy and stable. After roughly 20–30 seconds the failure begins and the dashboard
degrades in real time. A manual trigger exists for recordings and impatient judges.

**Why this is a strong choice.** A judge *watching the system break* is worth more than any
screenshot. It also proves the engine is genuinely computing rather than replaying a fixture —
a static red dashboard on load proves nothing.

**Recommendation.** Keep the healthy window short (20s). Long enough to establish a baseline the
degradation is visible against; short enough that nobody gives up. The manual trigger must also
allow *choosing* which scenario fires, so it doubles as the scenario picker from D5.

## D5 — Concurrency: one incident at a time

A picker selects which scenario is active. Switching scenarios resets the clock.

**Why this is the right call — agreed without reservation.** Concurrent incidents sound impressive
and are a trap: several interleaved failure chains make determinism far harder to guarantee, and a
judge watching two incidents at once cannot tell whether the agent reasoned well or got lucky. One
clear incident makes the agent's reasoning legible, which is the thing being judged.

## D6 — Approval policy: always ask

Every **agent-initiated environment mutation** blocks on an explicit human click. No tiers, no
configuration, no auto-approval.

**What "environment mutation" means — the exact boundary.** The original wording said "every
state-changing action", which was too broad to build against: writing a proposal record, or moving
an incident from `investigating` to `identified`, is a state change, and gating those would make the
agent unusable while proving nothing. `spec.md` FR-0 fixes three classes and this decision applies
to the third only:

| Class | What it changes | Approval |
|---|---|---|
| A — Observation | Nothing | None |
| B — Record operation | Incident, proposal and postmortem records only | None, but fully audited |
| C — Environment mutation | The simulated production environment | **Required, always** |

Exactly one tool is Class C: `execute_remediation`. That is the entire surface through which
production can change, and it cannot run without a human click.

Human-initiated actions in the dashboard are exempt, because the human performing them is already
the approver.

**Why this is defensible.** The safety story is absolute and needs no caveats: *nothing* reaches
production without a human. It is also the simplest thing to build correctly, and correctness here
matters more than sophistication.

**Recommendation — the one place I would refine.** Your story's closing vision is "humans set the
intent and guardrails, while agents operate." A configurable risk-tier policy is literally that
sentence implemented, and it is a stronger governance story than a permanent modal.

I am **not** proposing to change the decision. Always-ask ships as the default and shipped
behaviour. I am proposing it as a **stretch goal after the core flow is deployed**: a settings
panel where LOW-risk actions can be set to auto-approve, with always-ask as the factory default.
If time runs short it is dropped and nothing is lost. Your call, and the current decision stands
either way.

## D7 — Simulated time: speed control (1x / 10x / 60x)

A live speed control in the UI. At 60x a four-hour memory leak plays out in four minutes.

**Why this is a strong choice.** It is what makes five scenarios *honest*. A memory leak that
degrades over 40 seconds is not a memory leak; it is a config error wearing a costume. Speed
control lets every scenario keep its true timescale while still fitting a three-minute video.

**Two architectural rules this creates — both mandatory.**

1. **Every simulated value derives from the sim clock.** No `setInterval` driving business logic,
   no `Date.now()` anywhere in the engine. One tick function advances the world. Violating this
   means charts, logs and traces drift apart the moment someone changes speed, and the evidence
   stops agreeing with itself.
2. **The approval timeout stays on the wall clock.** The 60-second window for a human to approve is
   real time and must not scale with sim speed. At 60x a sim-clock timeout would expire in one real
   second and every approval would fail. These two clocks must never be confused.

**Recommendation.** Show the sim clock and the current multiplier permanently in the header, so a
judge is never confused about why time is moving quickly.

## D8 — Evidence citation: required and validated

`propose_remediation` requires `evidence_ids`, and the app verifies each id was genuinely returned
by a prior read-only tool call in this session. Unverifiable citations are rejected.

**Why this is the strongest decision of the eight.** It converts "the agent should investigate
before acting" from a hope into an enforced rule. An agent that guesses a plausible root cause
without doing the work is refused by code. Every judge on that panel has watched a model
confidently invent an answer; showing a system that structurally cannot accept one is a genuine
contribution, not a demo trick.

It also makes the approval card substantive. The human sees the hypothesis *and* the receipts.

**Recommendations — three refinements that make it work rather than merely strict.**

1. **Require at least two evidence ids from two different sources.** One log line should not be
   enough to justify a HIGH blast-radius action. Forcing correlation across sources is exactly the
   reasoning the project claims to demonstrate.
2. **Rejection messages must teach, not just refuse.** Return something the agent can act on:
   `"evidence id log_999 was never retrieved in this session — call search_logs first"`. A bare
   refusal makes the agent flail; an instructive one makes it investigate. This is the difference
   between a guardrail and a wall.
3. **Never reject by throwing.** Resolve with the refusal text, per the async rule in
   `000-research.md`. A rejected promise gives the agent nothing to reason about.

---

## Assumptions I am making without asking

These follow from decisions above or from the research. Overrule any of them.

| Assumption | Rationale |
|---|---|
| No authentication | The rules permit it, but every second of judge friction is a cost with no scoring benefit. |
| State resets on page reload | Determinism. A fresh load is always a clean, seeded T+0. |
| Postmortem renders as markdown in-app, copyable and downloadable | Downloads are blocked in some embedded browsers, so copy-to-clipboard is the primary path. |
| Tools never expose scenario identity | Stated under D1. Non-negotiable — it is the difference between investigation and lookup. |
| Audit log records `source` (`webmcp` / `ui`) and `actor` (`human` / `agent`), inputs, output summary, duration, status | Required by D3, and it is the project's best visual. Two fields, not one: a human invoking a tool from the DevTools panel is `webmcp` + `human`, and a human clicking a dashboard button is not a tool invocation at all. |
| One page, no routing | From `000-research.md`: navigating away destroys registered tools. |

## Open, deferred to the build spec

- Chart library choice.
- Whether the postmortem is generated from a template or free-form by the agent.
- Exact metric retention window in the ring buffer.
