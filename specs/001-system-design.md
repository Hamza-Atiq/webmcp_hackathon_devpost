# System Design — AgentOps Command Center

Phase 2 of the spec-driven workflow. Builds on `000-research.md`.
Written to be readable by the whole team, including the team lead reviewing the idea.

> **Status: superseded in part.** `specs/spec.md` is the final behavioural specification and the
> source of truth. Where this document and `spec.md` disagree, `spec.md` wins. This document is
> retained for its rationale — the *why* behind the architecture — not for its numbers. Known
> divergences have been corrected in place below; the reasoning is unchanged.

---

## 1. What we are actually building

A single web page that behaves like a real production monitoring console, containing a
**live simulation of a small microservice system**. The simulation is not a script and not
canned JSON — it is a running engine with a clock, seeded randomness, real traffic, and real
cause and effect.

When a bad version is deployed, the numbers get worse **because the engine computes them that
way**, not because a fixture said so. When the deployment is rolled back, the numbers recover
for the same reason. This is what makes an agent's investigation genuine: the answer is not
pre-written anywhere.

On top of that system sits the WebMCP tool layer, which lets an AI agent investigate the
incident and — with a human's explicit approval — fix it.

## 2. Backend or no backend

The real question is not "server or no server". It is **scripted or real**.

| | Scripted (reject) | Real engine (build) |
|---|---|---|
| Tool returns | Hardcoded JSON fixtures | Computed from live state |
| Root cause | Already written in the data | Must be derived by correlating sources |
| Rollback | Swaps to a "healthy" fixture | Changes config; system genuinely recovers over time |

**Decision: build the real engine, and run it in the browser first.**

The engine is a self-contained module — clock, seeded PRNG, services, traffic generator,
metric aggregator, log emitter, trace recorder, deployment registry. It exposes a plain
interface (`getServiceHealth`, `queryLogs`, `getTrace`, `deploy`, `rollback`, …).

The WebMCP tool layer calls that interface. It does not care where the engine runs.

Running it client-side first is the right call:

- Zero deployment risk and no cold starts.
- Determinism is trivial to guarantee.
- The graded surface (the WebMCP layer) is byte-for-byte identical either way.

**Stretch goal, only if time remains:** move the engine behind an HTTP API. Because the tool
layer talks to an interface rather than to the engine directly, this is a swap of one adapter
and touches no tool code. Do not start this until the core flow is finished and deployed.

## 3. Background: what an SRE platform is

SRE means Site Reliability Engineering — the discipline of keeping services up, fast and
correct. An SRE platform is the set of tools those engineers use. Five kinds of evidence:

| Evidence | Question it answers | Real-world product |
|---|---|---|
| Metrics / dashboard | Is it healthy right now? | Grafana, Datadog |
| Logs | What exactly happened at 14:32? | Loki, Splunk |
| Traces | Where inside one request did time go or failure occur? | Jaeger, OpenTelemetry |
| Deployments | What changed recently? | Argo CD, Spinnaker |
| Runbooks | What do we do about this known failure? | Notion, Confluence |

Plus **incident management** (PagerDuty, incident.io): the record of the event — severity,
status, timeline, and the postmortem written afterwards.

The four numbers engineers watch are the **golden signals**: latency, traffic, errors,
saturation.

**The fact the whole project rests on:** the large majority of production incidents are caused
by a recent change. So the first real question in any incident is "what shipped recently?", and
the most common fix is to roll that change back. That is why the story's flow is realistic
rather than invented.

## 4. The scenario

One incident, modelled deeply. Deterministic, seeded, replayable.

**Setup.** Five services: `api-gateway`, `checkout-service`, `payment-service`,
`inventory-service`, `user-service`. Steady traffic around 450 requests per second.

**The change.** At T+0, `checkout-service v2.4.1` is deployed. Its config changes the database
connection pool maximum from 50 to 5 — someone reducing memory usage without understanding the
consequence.

**The failure chain.**

1. With only 5 connections, incoming requests queue waiting for one.
2. `checkout-service` p99 latency climbs from ~180ms to ~4.2s.
3. Requests exceed the 3s gateway timeout and return 504s.
4. Error rate rises from ~0.3% to ~11%.
5. Callers retry, so `payment-service` load also rises.

**Step 5 is deliberate.** It makes `payment-service` look guilty. An agent that only glances at
the dashboard will blame payment. That is the wrong answer, and ruling it out is what makes this
a genuine reasoning task rather than a lookup.

**The evidence trail.**

| Source | What it shows |
|---|---|
| Metrics | checkout error rate and p99 both step up one minute after the deploy |
| Traces | ~3.9s of a 4.2s request is spent in `db.acquire_connection`, not in query execution — it is waiting for a connection, not running slow SQL |
| Logs | `pool exhausted: 5/5 connections in use, 47 waiters` |
| Deploy diff | `DB_POOL_MAX: 50 → 5` in v2.4.1 |
| Runbook | "Checkout latency spike" → check recent deploys → if a deploy correlates, roll back |
| Ownership | checkout-service owned by Team Payments, on-call engineer named |

**Correct diagnosis.** Connection pool starvation introduced by the config change in v2.4.1.
`payment-service` is a symptom, not a cause.

**Remediation.** Roll back to v2.4.0. Pool returns to 50, the queue drains, latency and error
rate recover over roughly 60 simulated seconds.

No single source proves the root cause. The agent has to join at least three.

## 5. The tool layer

Around thirteen tools, split by the safety boundary.

### Read-only — `readOnlyHint: true`, no approval

| Tool | Purpose |
|---|---|
| `list_services` | Service inventory with current health status |
| `get_service_health` | Golden signals for one service |
| `get_metrics` | Time series for a metric, service and time window |
| `search_logs` | Query logs by service, level, time, text. **`untrustedContentHint: true`** |
| `get_trace` | Full span tree for one request |
| `list_recent_deployments` | What shipped, when, by whom |
| `get_deployment_diff` | What actually changed in a deployment |
| `get_runbook` | Runbook for a symptom or service |
| `get_service_ownership` | Owning team and current on-call |
| `get_incident` | Current incident record and timeline |

### Record operations — Class B, `readOnlyHint: false`, no approval

These write to incident, proposal and postmortem **records**. They never touch the simulated
production environment, which is why they are not gated. See `spec.md` FR-0 for the definitive
three-class split.

| Tool | Purpose |
|---|---|
| `propose_remediation` | Agent submits hypothesis, proposed action, and cited evidence ids. Returns a `proposal_id`. |
| `update_incident_status` | Moves the incident through its lifecycle. Audited. |
| `generate_postmortem` | Produces the written postmortem from the recorded evidence chain |

`verify_remediation` reads measured metrics and compares them against a stored before-snapshot. It
mutates nothing, so it is Class A (read-only) alongside the investigation tools.

### Environment mutation — Class C, `readOnlyHint: false`, approval required

| Tool | Approval | Purpose |
|---|---|---|
| `execute_remediation` | **required** | The only tool in the entire system that can change the simulated production environment. Accepts a `proposal_id` in `pending` status, moves it to `awaiting_approval`, and blocks until a human decides. |

`search_logs` carries `untrustedContentHint` because log lines are attacker-controllable text.
The spec is explicit that tool return values reach the model as trusted information, so this is
the correct annotation and a genuine security point, not decoration.

## 6. The approval gate

The core of the project. The standard provides no mechanism for this, so we build one.

**Two steps, not one.** The agent cannot jump straight to acting.

```
Agent calls propose_remediation(hypothesis, action, evidence_ids)
  → engine records proposal, status = pending
  → UI shows the proposal card READ-ONLY: the hypothesis, the proposed action,
    the evidence the agent cited, and the blast radius.
    Approve / Deny are NOT active yet.
  → returns proposal_id immediately (this call does not block)

Agent calls execute_remediation(proposal_id)
  → status moves pending → awaiting_approval
  → Approve / Deny become active on the card
  → THIS call blocks — the promise is held open
  → human clicks Approve or Deny in the dashboard
  → promise resolves with the outcome
```

**Why Approve is inactive while merely `pending`.** If a human could approve a proposal before the
agent asked to execute it, the proposal would leave `pending` and `execute_remediation` would then
refuse it — approving would make the action impossible. Approval settles an *active* execution
request and nothing else. This also puts the human decision visibly inside the tool call, which is
the whole point.

**Why the boundary holds.** `execute_remediation` reads the proposal's status from engine state.
If it is not `pending`, it returns a refusal without acting. An agent that skips the proposal step,
invents a `proposal_id`, or calls execute twice is refused by code — not by a politely worded
description. This is the difference between a rule and an enforced rule.

**Rules for the blocking call**, from the research:

1. Timeout of 60 seconds; resolve on expiry with a clear message.
2. Always **resolve**, never **reject** — a resolved error string lets the agent recover and
   explain; a rejection just fails.
3. Each pending approval keyed by `proposal_id`, so concurrent calls never cross wires.
4. Clear the timer and listener whenever the promise settles.
5. Honour the `signal` passed into `execute` so an aborted call stops waiting.

**Denial is a first-class path.** A denied proposal returns the reason to the agent, which should
then investigate further rather than retrying. This is worth showing in the demo — it proves the
human is genuinely in control, not rubber-stamping.

## 7. Verification after the fix

Approval is not the end. The loop closes only when recovery is proven.

1. `execute_remediation` returns a before-snapshot and the action taken.
2. The engine recovers over ~60 simulated seconds — visibly, on the charts.
3. The agent calls `verify_remediation`, which returns before/after error rate and p99 plus a
   pass or fail verdict against the recovery threshold.
4. `update_incident_status` moves the incident to resolved.
5. `generate_postmortem` writes the record, citing the evidence ids gathered during the
   investigation.

If recovery does not happen, `verify_remediation` fails and says so. The agent must not be able
to declare success on its own word.

## 8. Observability of the agent itself

A unified **Activity Log** panel records every operation, from either origin: timestamp, operation,
arguments, result summary, duration, status, side-effect class, plus `source` (`webmcp` or `ui`) and
`actor` (`agent` or `human`).

Both fields are needed because they are not redundant: a human running a tool by hand from the
DevTools WebMCP panel is `source: webmcp, actor: human`. A human clicking Rollback in the dashboard
is `source: ui, actor: human` and is **not** a tool invocation at all — recording it as one would be
a lie in the audit trail.

This serves four purposes at once:

- Answers "which tools did the agent call, and which did it ignore?"
- Makes the human-agent collaboration visible instead of invisible.
- Gives the demo video its strongest visual.
- Provides the audit trail an incident review would legally require.

Chrome DevTools' own WebMCP panel gives an independent cross-check of the same calls, which is
useful both for debugging and as evidence in the README.

## 9. Determinism and reset

- The engine uses a **seeded PRNG**. The same seed produces the same run, every time.
- A **Reset scenario** control returns the clock to T+0 and restores healthy state.
- The demo can therefore be run repeatedly — for retakes, for each judge, and in testing —
  with identical results and **no code changes between runs**.
- Scenario state lives in one place. Nothing about a previous run leaks into the next.

## 10. Screen layout

One page, three regions, no navigation (tools must survive; navigating away destroys them).

- **Left** — service map with health status; the failing service is visibly red.
- **Centre** — incident header, live metric charts, and a tabbed evidence area for logs,
  traces and deployments.
- **Right** — Agent Activity Log, with the approval card appearing at the top when a proposal
  is pending.

A pending approval also raises a banner across the top so it is impossible to miss on video.

## 11. How we test

Three levels, weakest to strongest:

1. **DevTools WebMCP panel** (Application tab) — run each tool by hand with chosen inputs.
   Confirms registration, schema and return shape without any AI involved. This is the fast
   inner loop.
2. **Chrome with the flag** — `chrome://flags/#enable-webmcp-testing`. Confirms the app works
   for a judge who has no ChatGPT Work access.
3. **ChatGPT desktop built-in browser** — the real end-to-end run with an agent that has to
   reason. Requires the desktop app, GPT-5.6 Sol or Terra, and site tools enabled.

The README documents routes 2 and 3 with screenshots of both, so judges can reproduce either.

## 12. Build order

Nothing here is parallel-blocked; the engine is the dependency for everything else.

1. `LICENSE` and README skeleton. Graded requirement — do it first, not last.
2. Simulation engine: clock, seeded PRNG, services, traffic, metrics, logs, traces, deployments.
   Verify by console alone: deploy the bad version, confirm the numbers actually degrade.
3. Dashboard UI reading from the engine. Verify a human can diagnose the incident unaided —
   if a person cannot, an agent will not either.
4. Read-only tools. Verify every one through the DevTools panel.
5. Proposal and approval mechanism, including timeout, denial and the refusal path.
6. Action tools plus verification and postmortem.
7. Agent Activity Log panel.
8. Deploy. Test in Chrome with the flag, then in the ChatGPT desktop browser.
9. README with screenshots from both surfaces, and the demo video.

Stretch, in order of value: planted prompt-injection line in the logs with the untrusted-content
flag surfaced in the UI; a second scenario; the engine behind an HTTP API.

## 13. Open decisions

- Framework: plain JS versus React. React is easier for the approval card and live charts;
  plain JS has no build risk.
- Host: Vercel, Netlify, Cloudflare Pages or Render. Not load-bearing.
- Whether to build the second scenario at all, or spend the time on polish.
