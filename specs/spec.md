# spec.md — AgentOps Command Center

Phase 4 (Specify) of the spec-driven workflow, written after Clarify (`002-clarifications.md`).
This is the **final behavioural specification and the source of truth**. It supersedes the design
notes in `001-system-design.md` wherever the two disagree.

**This document describes behaviour only.** No frameworks, file layouts, libraries or data stores
appear here deliberately — those belong in the plan. Every requirement is written so that a build
which ignored it would visibly fail.

Requirements are numbered `FR-n` and referenced by the plan, the tasks and the acceptance criteria.

---

## 1. Goal

Incident response today forces an engineer to hold five disconnected tools in their head under
time pressure. Agents cannot help, because operating those tools means driving human interfaces
they can only guess at — and nobody should let a language model roll back production on its own
judgement anyway.

AgentOps Command Center is an incident response console where a human and an AI agent work the
same live incident together. The agent investigates across every evidence source, forms a
diagnosis it must support with citations, and proposes a fix. The human decides whether it happens.

The product exists to demonstrate a claim: **the valuable thing is not agent autonomy, it is a
clear, enforced boundary between what an agent may observe, what it may recommend, and what it may
execute.**

Success means a judge can watch a system break, watch an agent diagnose it correctly by
correlating evidence it actually gathered, approve a fix, and watch the system recover — and can
also do all of it themselves without an agent.

## 2. Users

**Priya, on-call SRE.** Paged at 02:00. Needs to know what broke, what changed, and what to do,
fast. Will not delegate a production rollback to software she cannot audit.

**The agent.** Has no screen and no intuition. Can call tools, read what they return, and reason.
Must be prevented from acting on a guess.

**The judge.** Has three minutes, may have no agent available at all, and is scoring whether this
is a real product or a technical demo wearing product clothes.

## 3. User scenarios

**S1 — Agent-led investigation.** The dashboard is healthy. An incident fires. Priya asks her agent
to investigate. The agent queries metrics, narrows to a service, reads traces, finds where time is
spent, correlates with recent deployments, retrieves the runbook, and proposes a specific
remediation citing the exact evidence it read. Priya reads the proposal, approves it, watches
recovery, and asks for a postmortem.

**S2 — Human-led, no agent.** A judge opens the app with no agent connected. They browse the same
evidence, reach their own conclusion, and execute the same remediation directly from the UI. The
product works end to end.

**S3 — Human overrules.** The agent proposes a rollback. Priya sees the cited evidence does not
support it, denies with a reason, and the agent resumes investigating rather than retrying.

**S4 — Agent tries to skip the work.** The agent proposes a remediation citing evidence it never
retrieved. The proposal is refused with an explanation of what is missing. It investigates first,
then proposes again.

**S5 — Wrong fix.** The agent misdiagnoses and proposes an action that does not address the cause.
Priya approves it. The system does not recover, verification reports failure, and the agent must
investigate again.

---

## 4. Functional requirements

### FR-0 — Defined values

Every threshold and definition referenced elsewhere in this document is fixed here. Nothing below
may be re-invented at build time.

**Side-effect classes.** Every tool belongs to exactly one class. The phrase "state-changing" is
deliberately not used as a category anywhere in this document, because it conflates two things that
must be governed differently: writing a record, and changing production.

| Class | Definition | Annotation | Approval |
|---|---|---|---|
| **A — Observation** | Reads environment or record state. Mutates nothing. | `readOnlyHint: true` | None |
| **B — Record operation** | Writes only to incident, proposal and postmortem **records**. Cannot alter the behaviour of any simulated service. | `readOnlyHint: false` | None, but fully audited |
| **C — Environment mutation** | Changes the simulated production environment itself, altering how services behave. | `readOnlyHint: false` | **Required when agent-initiated** |

| Class | Tools |
|---|---|
| A | The eleven tools in FR-6, plus `verify_remediation` |
| B | `propose_remediation`, `update_incident_status`, `generate_postmortem` |
| C | `execute_remediation` — and nothing else |

**Exactly one tool is Class C.** It is the entire surface through which the environment can change,
and FR-8 gates it.

**Healthy baseline**, per service, when no incident is active:

| Signal | Healthy value |
|---|---|
| Aggregate request rate | ~450 rps, natural variation within ±10% |
| Error rate | ≤ 0.5% |
| Latency p50 / p95 / p99 | ≤ 60 ms / ≤ 120 ms / ≤ 200 ms |
| CPU / memory | ≤ 45% / ≤ 60% |
| Replica count | 3 |

**Incident opens** when either condition holds for 15 consecutive simulated seconds:
error rate > 2%, or p99 > 1000 ms.

**Severity**, evaluated on the worst affected service:

| Severity | Condition |
|---|---|
| SEV-1 | Error rate > 25%, or a service serving no successful requests |
| SEV-2 | Error rate > 5%, or p99 > 3000 ms |
| SEV-3 | Above the incident threshold but below SEV-2 |

**Recovery / verification passes** only when error rate ≤ 1% **and** p99 ≤ 400 ms, both sustained
for 30 consecutive simulated seconds. Anything less is a failed verification.

**Partial relief** means a measurable improvement in at least one golden signal that still fails
the recovery thresholds. Verification **fails** and the incident stays open. Partial relief is
never sufficient to reach `resolved`.

**Evidence ids.** Log entries, traces, deployments, runbooks and ownership records each carry a
per-record id. A metrics query returns a single **query id** covering that metric, service and
window; the query id is the citable unit, not individual data points.

**Limits.** At most 3 proposals may be in `pending` or `awaiting_approval` status at once; further
proposals are refused with an explanation. Approval timeout is 60 seconds wall-clock. The healthy
window before a scenario auto-fires is 20 seconds wall-clock.

**Output bounds.** Chrome's tool-security guidance recommends at most **1500 characters per
individual tool output**. That is the design target for every tool; **4000 characters is a hard
ceiling** no response may exceed. The bounds are met by capping records, never by returning half a
record:

| Tool | Default | Maximum |
|---|---|---|
| `search_logs` | 20 entries | 50 entries |
| `list_traces` | 10 traces | 25 traces |
| `get_trace` | whole span tree | 40 spans |
| `get_metrics` | downsampled to 60 points per series | 60 points per series |
| `list_recent_deployments` | 10 deployments | 25 deployments |
| `get_incident` | 30 most recent timeline entries | 30 timeline entries |

Any truncated response carries `truncated: true`, `returned_count`, `total_count`, and one sentence
naming the filter that would narrow it.

### FR-1 — Simulated production environment

- FR-1.1 The system simulates five services: `api-gateway`, `checkout-service`,
  `payment-service`, `inventory-service`, `user-service`, with a defined dependency graph.
- FR-1.2 A traffic generator produces a continuous request stream, baseline approximately 450
  requests per second, with bounded natural variation.
- FR-1.3 Every metric, log entry and trace is **computed from simulated request outcomes**. No
  metric series, log line or trace may be read from a fixture, a recording, or a pre-written
  timeline.
- FR-1.4 Changing a service's configuration changes its observed behaviour through the simulation,
  not through a lookup table keyed on scenario.
- FR-1.5 The environment is driven by a seeded pseudo-random generator. Identical seed and
  identical action sequence produce identical output, including metric values, log content and
  trace timings.

**Failure test for FR-1.3:** if the phrase "expected error rate" can appear anywhere as stored
data, the requirement is not met.

### FR-2 — Scenario library

- FR-2.1 Five scenarios exist, selectable by name.
- FR-2.2 Exactly one scenario is active at a time. Selecting another resets the environment to a
  healthy T+0.
- FR-2.3 Each scenario defines its own failure mechanism, degradation profile, evidence trail,
  runbook and correct remediation.

| # | Scenario | Mechanism | Recent deploy exists |
|---|---|---|---|
| 1 | Config regression | `checkout-service` DB connection pool reduced 50 → 5. The pool is **shared at the service level** (a connection pooler), not per-replica — see FR-9.2a | Yes |
| 2 | Resource exhaustion | `inventory-service` memory leak, degrades over hours | Yes |
| 3 | Dependency failure | `payment-service` calls an external fraud-scoring provider behind the `payment_fraud_check_v2` flag; the provider is timing out | **No** |
| 4 | Bad migration | A standalone schema migration job holds locks on the `user-service` database; the application reads through the migrating schema behind the `user_profile_schema_v2` flag | Yes, but **unrelated** |
| 5 | Capacity | Traffic spike exceeding replica headroom | **No** |

- FR-2.4 Scenarios 3 and 5 have **no deployment inside the incident window**. An agent that
  reflexively rolls back must fail on these. This is deliberate and must not be softened.
- FR-2.4a Every service nevertheless retains a prior version in its deployment history, so
  `rollback_deployment` is always **executable** and is never refused for want of a target. In
  scenarios 3 and 5 it rolls back to a version that predates the degradation, is approved like any
  other action, and simply does not help. `list_recent_deployments` returns that deployment with
  its timestamp so the agent can see for itself that it predates the incident — evidence to reason
  from, not a refusal to work around. Watching a HIGH blast-radius action be approved and then fail
  verification is the point of the exercise; refusing the call would teach nothing.
- FR-2.4b Scenario 4 is the inverse trap, and the sharpest of the five: a recent `user-service`
  deployment **does** exist and correlates in time, but it is a routine change unrelated to the
  migration causing the contention. Rolling it back is executable, plausible, and useless.
- FR-2.4c No remediation is the correct fix for more than two of the five scenarios. An agent with
  a fixed favourite action cannot exceed a 40% success rate.
- FR-2.5 No tool response, at any time, may disclose the active scenario's name, id, or any label
  describing its category. Tools expose symptoms only.

**Failure test for FR-2.5:** if an agent can name the root cause correctly using a single tool
call, the requirement is not met.

### FR-3 — Simulated clock

- FR-3.1 A single simulated clock drives all environment state. No business logic may derive
  timing from wall-clock time.
- FR-3.2 The clock runs at 1x, 10x or 60x, changeable at any time without restarting the scenario.
- FR-3.3 The current simulated time and speed multiplier are visible at all times.
- FR-3.4 Changing speed must not alter the *sequence* or *values* of simulated events, only the
  rate at which they occur. A run at 60x and a run at 1x produce the same evidence.
- FR-3.4a The simulation therefore advances in **fixed-size ticks**. The speed multiplier changes
  only how many ticks elapse per real second — never the size of a tick. Advancing the world by a
  variable wall-clock delta would make results depend on frame timing and violate FR-1.5.
- FR-3.5 **Approval timeouts are measured on wall-clock time and never scale with the multiplier.**

**Failure test for FR-3.5:** at 60x, a human must still have a full real minute to approve.

### FR-4 — Evidence sources

Each source returns records carrying a **stable, unique id** that remains valid for the life of
the scenario run and can be cited later as evidence.

- FR-4.1 **Metrics** — time series for request rate, error rate, latency percentiles (p50, p95,
  p99), CPU, memory and replica count, per service, queryable over a time window.
- FR-4.2 **Logs** — structured entries with timestamp, service, level, message and correlation id;
  filterable by service, level, time window and free text.
- FR-4.3 **Traces** — per-request span trees with per-span durations, showing where time was spent
  and where errors originated.
- FR-4.4 **Deployments** — version history per service with timestamp, author, and a
  configuration diff showing what changed.
- FR-4.5 **Runbooks** — written procedures retrievable by symptom or service.
- FR-4.6 **Ownership** — owning team and current on-call contact per service.
- FR-4.7 **Incident record** — id, severity (SEV-1 to SEV-3), status, affected services, and a
  chronological timeline.
- FR-4.8 Evidence must be sufficient but not conclusive in isolation: **no single source may
  identify the root cause of any scenario.** Correct diagnosis requires correlating at least two.

### FR-5 — Incident lifecycle

- FR-5.1 The environment starts healthy and remains healthy for approximately 20 seconds of
  wall-clock time before the active scenario begins.
- FR-5.2 A manual trigger starts any chosen scenario immediately, bypassing the wait.
- FR-5.3 When degradation crosses defined thresholds, an incident is opened automatically with an
  assigned severity.
- FR-5.4 Incident status progresses through: `detected` → `investigating` → `identified` →
  `mitigating` → `resolved`.
- FR-5.5 Every status change, tool call and remediation is appended to the incident timeline with
  its actor.

### FR-6 — Agent tool layer: read-only

All tools in this group are **Class A** (FR-0): annotated `readOnlyHint: true`, never gated on
approval, and they mutate neither environment nor record state.

| Tool | Behaviour |
|---|---|
| `list_services` | Service inventory with current health status and dependency edges |
| `get_service_health` | Golden signals for one service: latency, traffic, errors, saturation |
| `get_metrics` | Time series for a named metric, service and time window |
| `search_logs` | Filter by service, level, time window, free text. Annotated `untrustedContentHint: true` |
| `get_trace` | Full span tree for one trace id |
| `list_traces` | Recent traces for a service, filterable by slow or errored |
| `list_recent_deployments` | Deployment history, optionally filtered by service and window |
| `get_deployment_diff` | Configuration changes introduced by one deployment |
| `get_runbook` | Runbook matching a symptom or service |
| `get_service_ownership` | Owning team and on-call contact |
| `get_incident` | Current incident record and full timeline |

- FR-6.1 Every response includes the ids of the records returned, in a form citable as evidence.
- FR-6.2 `search_logs` carries `untrustedContentHint: true` because log content originates from
  request data and is not trustworthy input to a model. The annotation is advisory — nothing in the
  standard obliges an agent to honour it — so the response body **also** carries an explicit
  `content_trust: "untrusted"` field, which the model reads as data rather than as metadata it may
  silently ignore.
- FR-6.3 Tools return only what was asked for, never a whole-environment dump, and respect the
  output bounds fixed in FR-0. A response that would exceed its record cap is truncated with
  `truncated: true`, `returned_count`, `total_count`, and guidance on narrowing the query.

### FR-7 — Proposal and evidence validation

- FR-7.1 `propose_remediation` accepts a hypothesis, a target service, a proposed action with its
  parameters, and a list of evidence ids. It returns a `proposal_id`. It does not block.
- FR-7.2 A proposal is **rejected** unless it cites **at least two evidence ids drawn from at
  least two different evidence sources.**
- FR-7.3 A proposal is **rejected** if any cited evidence id was not actually returned to the
  caller by a prior read-only tool call within the current scenario run.
- FR-7.4 Rejections are instructive: they name which id failed and what to do about it (for
  example, that the id was never retrieved and which tool would retrieve it).
- FR-7.5 Rejections **resolve** with refusal text. No tool in the system may reject its promise.
- FR-7.6 A proposal is created in `pending` status and is immediately visible in the interface,
  showing the hypothesis, the proposed action, the action's blast radius, and every cited piece of
  evidence in readable form. In this status the card is **read-only**: Approve and Deny are visible
  but inactive, labelled as awaiting the agent's execution request (FR-8.1a).

**Failure test for FR-7.3:** an agent that calls `propose_remediation` as its very first tool call
must be refused.

### FR-8 — Approval gate

- FR-8.0 A proposal moves through exactly this state machine. No other transition exists.

```
                     ┌─ evidence validation fails ──> refused (no proposal created)
                     │
propose_remediation ─┴─> pending ─ execute_remediation ─> awaiting_approval
                            │           called                   │
                            │                                    ├─ human approves ─> approved ─> executed
                            │                                    ├─ human denies ───> denied
                            │                                    ├─ 60s wall-clock ─> expired
                            │                                    └─ agent aborts ───> cancelled
                            │
                            └─ scenario switched, or incident resolved by a human ──> cancelled
```

  `approved`, `executed`, `denied`, `expired` and `cancelled` are all terminal for the purposes of
  `execute_remediation`: a proposal in any of them is never executable again.

- FR-8.1 `execute_remediation` accepts a `proposal_id`. If that proposal is in `pending` status it
  moves it to `awaiting_approval` and **blocks** until resolved.
- FR-8.1a **Approval settles an active `execute_remediation` call and nothing else.** Approve and
  Deny are inactive while a proposal is merely `pending`, and become active only on entry to
  `awaiting_approval`. There is therefore no path by which a human can approve a proposal into a
  status that `execute_remediation` would then refuse. This also places the human decision visibly
  inside the tool invocation, which is the behaviour the product exists to demonstrate.
- FR-8.2 It resolves only when a human approves or denies in the interface, or on timeout.
- FR-8.3 Every **agent-initiated Class C** operation (FR-0) requires explicit human approval. There
  is no auto-approval and no configurable exemption. Class A and Class B tools are never gated.
  Human-initiated actions taken directly in the interface are exempt, because the human performing
  them is already the approver (FR-12.5).
- FR-8.4 It refuses, without acting, if the `proposal_id` is unknown or is in any status other than
  `pending` — including `awaiting_approval`, so a second concurrent call for the same proposal is
  refused rather than queued.
- FR-8.5 Timeout is 60 seconds of wall-clock time. On expiry the call resolves with a timeout
  message and the proposal moves to `expired`. No action is taken.
- FR-8.6 Denial resolves with the human's stated reason, so the agent can reason about it rather
  than blindly retry.
- FR-8.7 Concurrent pending approvals are tracked independently by `proposal_id` and never
  cross-resolve.
- FR-8.8 If the calling agent aborts, the pending approval is cancelled and no action occurs.
- FR-8.9 A pending approval is unmissable in the interface — a persistent, prominent prompt, not a
  subtle badge.

**Failure test for FR-8.3:** no sequence of tool calls, in any order, may change environment state
without a human click.

### FR-9 — Remediation actions

Five actions, each with a declared blast radius shown to the human before approval.

| Action | Blast radius | Effect |
|---|---|---|
| `rollback_deployment` | HIGH | Restores the previous version's configuration |
| `restart_service` | MEDIUM | Clears process state; in-flight requests fail |
| `scale_replicas` | LOW | Changes replica count, altering per-replica load |
| `disable_feature_flag` | MEDIUM | Bypasses a code path and any call it makes |
| `shift_traffic` | HIGH | Reroutes traffic away from a target |

- FR-9.1 Each action's effect is applied to the simulated environment and takes effect through
  simulation, over time. No action produces instant recovery.
- FR-9.2 **An action only resolves an incident if it addresses that incident's actual mechanism.**
  The outcome matrix below is mandatory:

| Scenario | Full fix | Partial relief | No effect | Makes worse |
|---|---|---|---|---|
| 1 Config regression | `rollback_deployment` | `scale_replicas` | flag, `shift_traffic` | — |
| 2 Memory leak | `rollback_deployment` | `scale_replicas` | flag, `shift_traffic` | — |
| 3 Dependency failure | `disable_feature_flag` | `shift_traffic` | rollback, restart | — |
| 4 Bad migration | `disable_feature_flag` | `shift_traffic` | rollback, restart | `scale_replicas` |
| 5 Capacity | `scale_replicas` | `shift_traffic` | rollback, restart, flag | — |

`restart_service` is absent from scenario 2's columns because it belongs in none of them — see
FR-9.3. No action appears in the "full fix" column more than twice (FR-2.4c).

- FR-9.2a **The connection pool in scenario 1 is shared at the service level, not per-replica.**
  This is what makes `scale_replicas` *partial* relief rather than a second full fix: adding
  replicas spreads CPU load but adds no connections, so the queue that is actually causing the
  latency is untouched and only `rollback_deployment` — restoring `DB_POOL_MAX` to 50 — drains it.
  A per-replica pool would multiply capacity with every added replica and would therefore resolve
  the incident, contradicting FR-9.2. Shared connection poolers are standard production practice,
  so this costs no realism.

- FR-9.3 In scenario 2, `restart_service` produces temporary recovery followed by renewed
  degradation — mitigation, not a fix. The distinction must be observable in the metrics.
- FR-9.4 In scenario 4, `scale_replicas` measurably worsens the incident: more replicas open more
  database connections, increasing contention for the locks the migration already holds.
- FR-9.4a In scenario 4 the contention comes from a standalone migration job, not from the recent
  `user-service` deployment, so `rollback_deployment` executes successfully against an unrelated
  deployment and has no beneficial effect (FR-2.4b). The full fix is `disable_feature_flag` on
  `user_profile_schema_v2`, which stops the application reading through the migrating schema and
  releases the contention. This is how a bad migration is actually mitigated in production: a
  migration already in flight cannot be un-run by redeploying application code, so the recovery
  path is to stop using the new schema, not to reverse it.
- FR-9.5 Actions taken against the wrong service have no beneficial effect.

**Failure test for FR-9.2:** if any action resolves any incident regardless of cause, the entire
premise of the product is void.

### FR-10 — Verification

- FR-10.1 `verify_remediation` accepts an optional `action_id` and compares the before-snapshot
  captured when that action was applied against current state, returning a pass or fail verdict
  against the recovery thresholds in FR-0.
- FR-10.1a `action_id` defaults to the most recently applied action, and the response always names
  which action it verified. Every applied action — agent-initiated or human-initiated — returns an
  `action_id` and stores its before-snapshot, so "before the action" is never ambiguous after
  several remediations. An unknown `action_id` is refused with the list of valid ones.
- FR-10.1b `verify_remediation` is Class A (FR-0): it reads and compares, and mutates nothing.
- FR-10.2 The verdict is computed from measured metrics. It is never derived from which action was
  taken, nor from the agent's stated expectation.
- FR-10.3 A failed verification states which signals are still out of bounds.
- FR-10.4 An incident may only reach `resolved` when verification passes.

**Failure test for FR-10.2:** approving a wrong action must produce a failed verification.

### FR-11 — Incident closure

- FR-11.1 `update_incident_status` (Class B) moves the incident through its lifecycle, recording
  the actor. It writes to the incident record only and is never gated on approval.
- FR-11.2 `generate_postmortem` (Class B) produces a written postmortem containing: timeline, affected
  services, severity, root cause, evidence cited, actions taken with their approver, verification
  result, and time to resolution.
- FR-11.2a The recorded root cause is **the approved hypothesis, attributed to its author** —
  agent or human — and labelled as such. The system never asserts a root cause of its own, because
  doing so would disclose the scenario's true mechanism and violate FR-2.5. A postmortem may
  therefore record a diagnosis that was wrong; that is correct behaviour, not a defect.
- FR-11.3 The postmortem is assembled from the recorded evidence and audit trail — never from
  unsupported narrative.
- FR-11.4 The postmortem is displayed in the interface and can be copied to the clipboard.

### FR-12 — Human parity

- FR-12.1 Every remediation action available to the agent is available to a human directly in the
  interface, with the same parameters.
- FR-12.2 Human and agent actions execute through the same underlying operations. Two parallel
  implementations are not permitted.
- FR-12.3 All evidence in FR-4 is browsable in the interface without any agent present.
- FR-12.4 A human can complete an entire incident — detect, investigate, remediate, verify,
  postmortem — with no agent involved.
- FR-12.5 Human-initiated actions do not require a proposal or approval; the human is already the
  approver.

### FR-13 — Audit trail

- FR-13.1 Every **operation** is recorded — both agent tool invocations and human actions taken in
  the interface — with: timestamp, entry kind (`tool_call` or `ui_action`), operation name,
  `source` (`webmcp` or `ui`), `actor` (`human` or `agent`), arguments, result summary, duration,
  status, and side-effect class (FR-0).
- FR-13.1a `source` and `actor` are separate fields because they are not redundant. A human
  invoking a tool by hand from the Chrome DevTools WebMCP panel is `source: webmcp, actor: human` —
  the page cannot distinguish that from an agent and must not pretend to. A human clicking a
  dashboard control is `source: ui, actor: human` and is **not** a tool invocation; recording it as
  one would make the audit trail untrue.
- FR-13.2 The trail is visible in the interface, live, in chronological order, as one unified
  timeline covering both sources.
- FR-13.3 Failed and refused calls are recorded with their reason, not silently dropped.
- FR-13.4 The trail distinguishes at a glance which tools were used and which were not.
- FR-13.5 The trail is the source of truth for evidence validation in FR-7.3. Only entries with
  `source: webmcp` count towards it: evidence a human browsed in the interface was never returned
  to the agent, so it cannot support the agent's citation.

### FR-14 — Tool registration

- FR-14.1 Tools are registered via `document.modelContext.registerTool`.
- FR-14.2 All tools register on the top-level page. No tool is registered inside an iframe.
- FR-14.3 The interface is a single page. No navigation may occur that would destroy registered
  tools.
- FR-14.4 All tools are registered **exactly once** at startup and remain registered for the
  session. Availability is governed by state checks inside the tools, never by unregistering and
  re-registering them. Registering a name that is already registered is rejected by the standard
  with an `InvalidStateError`, so re-registration is not a fallback: a double-registration bug
  surfaces as a missing tool. Startup registration must therefore be idempotent and run once.
- FR-14.5 Every tool declares an input schema with typed, described parameters, and validates its
  input, returning a descriptive message on invalid input.
- FR-14.6 The application functions normally in a browser with no WebMCP support.

### FR-15 — Reset and determinism

- FR-15.1 A reset control returns the environment to a healthy, seeded T+0.
- FR-15.2 Reset clears incident state, proposals, audit trail and remediation history completely.
- FR-15.3 No state from a previous run may influence a subsequent one.
- FR-15.4 A full page reload is equivalent to a reset.
- FR-15.5 Repeating a scenario with the same actions produces the same observable results, with no
  code changes between runs.

---

## 5. Edge cases and rules

| Situation | Required behaviour |
|---|---|
| Agent proposes before investigating | Refused per FR-7.3, with instructions |
| Agent cites a real id from a different scenario run | Refused; ids are scoped to the current run |
| Agent calls `execute_remediation` twice for one proposal | Second call refused; the action happens once |
| Agent invents a `proposal_id` | Refused |
| Human approves, then the agent aborts | Action already applied; the abort does not undo it |
| Human ignores an approval for 60 s | Resolves as expired; no action taken |
| Human denies with no reason | Accepted; the agent is told it was denied without a reason |
| Two proposals pending at once | Both tracked independently; approving one does not affect the other |
| Agent asks for a service that does not exist | Descriptive error naming valid services |
| Agent requests a time window with no data | Empty result with an explanation, not an error |
| Scenario switched while an approval is pending | Pending approvals cancelled and resolved with an explanation |
| Speed changed mid-approval | Approval timeout unaffected (FR-3.5) |
| Remediation applied to an already-healthy system | Permitted; recorded; has no beneficial effect |
| Agent calls a read-only tool during a pending approval | Permitted; investigation is never blocked |
| Human resolves the incident directly while a proposal is pending | Proposal cancelled and resolved with an explanation of what changed |
| A fourth proposal is submitted while three are pending | Refused with an explanation of the limit (FR-0) |
| Verification requested before any remediation | Returns a fail verdict naming the signals still out of bounds |
| Human tries to approve a proposal the agent has not yet asked to execute | Not possible: Approve and Deny are inactive until `awaiting_approval` (FR-8.1a) |
| `execute_remediation` called twice concurrently for one proposal | Second call refused — the proposal is `awaiting_approval`, not `pending` (FR-8.4) |
| `verify_remediation` called with no `action_id` after several remediations | Verifies the most recent applied action and names which one it used (FR-10.1a) |
| Rollback proposed in a scenario with no deployment in the incident window | Executable and approved as normal; rolls back to the prior version, has no beneficial effect, fails verification (FR-2.4a) |
| A tool response would exceed its record cap | Truncated with `truncated`, `returned_count`, `total_count` and narrowing guidance; never a split record (FR-0, FR-6.3) |

---

## 6. Out of scope

- Real infrastructure, real telemetry vendors, real credentials of any kind.
- Authentication and user accounts.
- Multi-user or collaborative sessions.
- Persistence across reloads.
- Multiple simultaneous incidents.
- Multi-agent collaboration.
- Configurable approval policy — always-ask is the shipped behaviour. Recorded as a possible
  later addition only.

---

## 7. Acceptance criteria

The build is done when all of the following can be demonstrated. Each maps to requirements above.

**AC-1 — It breaks by itself.** Load the app. Within ~20 seconds, without any interaction, the
dashboard degrades from healthy to an open incident with correct severity. *(FR-1, FR-5)*

**AC-2 — The evidence agrees with itself.** For the active scenario, metrics, logs, traces and
deployment history independently corroborate the same underlying mechanism, with matching
timestamps. *(FR-4)*

**AC-3 — No single-source diagnosis.** For each of the five scenarios, no one evidence source is
sufficient to identify the root cause. *(FR-4.8, FR-2.5)*

**AC-4 — Unsupported citations are impossible.** `propose_remediation` as a first call is refused.
A proposal citing one source is refused. A proposal citing a fabricated id is refused. Each refusal
explains what to do. *(FR-7)*

The claim here is **provenance, not semantics**: every id in an accepted proposal provably came back
from a real read-only call in this run, drawn from at least two sources. The system does not, and
cannot, judge whether that evidence genuinely *supports* the stated hypothesis — an agent may still
cite two real ids behind a poor conclusion. That judgement stays with the human approver, which is
why the approval card renders every cited record in full. Claiming more than this would be the same
failure the product exists to prevent.

**AC-5 — Nothing acts without a human.** No sequence of *agent* tool calls changes environment
state without an explicit human click. Verified by attempting it. *(FR-8.3)*

**AC-5a — Severity is assigned correctly.** Each scenario opens an incident at the severity its
measured signals imply under FR-0, not at a severity stored with the scenario. *(FR-0, FR-5.3)*

**AC-6 — Approval genuinely blocks.** `execute_remediation` remains pending while a human decides,
resolves on approve, on deny with reason, and on timeout at 60 wall-clock seconds — including
while the sim clock runs at 60x. *(FR-8)*

**AC-7 — Wrong fixes fail.** For each scenario, applying an action from the "no effect" column
leaves the incident unresolved and produces a failed verification. In scenario 4, `scale_replicas`
measurably worsens it. *(FR-9.2, FR-10.2)*

**AC-8 — Rollback is not a universal answer.** `rollback_deployment` is executable in all five
scenarios and never refused for want of a target, yet resolves only two of them. In scenarios 3 and
5 it rolls back a deployment that predates the incident. In scenario 4 it rolls back a real, recent,
time-correlated deployment that is nevertheless unrelated to the cause. In all three it is proposed,
approved, applied, and produces a failed verification.
*(FR-2.4, FR-2.4a, FR-2.4b, FR-9.4a)*

**AC-9 — Correct fixes recover.** For each scenario, the correct action produces observable
recovery over time, passing verification, allowing status `resolved`. *(FR-9, FR-10)*

**AC-10 — A human alone can do everything.** With no agent connected, a person can complete an
entire incident end to end, using every remediation action. *(FR-12)*

**AC-11 — The trail is complete.** Every operation from either origin appears in one unified trail
with `source`, `actor`, arguments, result, duration and side-effect class — including refused calls.
A human clicking a dashboard control is recorded as a `ui_action`, not as a tool invocation.
*(FR-13)*

**AC-12 — It repeats exactly.** Running the same scenario twice with the same actions produces the
same metrics, logs, traces and outcome, with no code changes between runs. *(FR-15)*

**AC-13 — It works on both surfaces.** Every tool is discoverable and invocable in Chrome with
WebMCP enabled, and in the ChatGPT desktop app's built-in browser, on the deployed URL.
*(FR-14)*

**AC-14 — It degrades gracefully.** In a browser without WebMCP, the application loads and is fully
usable by a human. *(FR-14.6)*

**AC-15 — The full arc runs.** An agent investigates, correlates evidence, proposes with citations,
is approved by a human, executes, verifies recovery, resolves the incident, and generates a
postmortem citing the evidence actually used. *(all)*
