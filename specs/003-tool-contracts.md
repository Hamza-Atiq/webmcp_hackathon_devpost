# 003 — Tool contracts (read-only layer)

Phase 3 of the build plan. Defines the twelve **Class A** tools of `spec.md` FR-0: the eleven
read-only tools in FR-6 plus `verify_remediation`. Proposal, approval and execution (Classes B
and C) are specified separately in P4 and are deliberately absent here.

`spec.md` remains the source of truth. This document only fixes the *contracts* it leaves open:
exact tool names, input schemas, output shapes, bounding behaviour, error text, and where the code
lives. Where this document and `spec.md` disagree, `spec.md` wins and this file is the one that
changes.

---

## 1. What must exist before a single tool is written

Four things the tools depend on do not exist yet. This was found by auditing P0–P2 against
`spec.md`, not by recall. Each is small, and each blocks a named tool.

| Gap | Requirement | Blocks |
|---|---|---|
| No runbooks | FR-4.5 | `get_runbook` |
| No ownership records | FR-4.6 | `get_service_ownership` |
| `correlationId` is declared on `LogEntry` but never populated | FR-4.2 | tying a log line to a trace — weakens FR-4.8 |
| Applied actions return no `action_id` and store no before-snapshot | FR-10.1a | `verify_remediation` |

These land first, each verified in the browser before the tool that needs it is written.

**A note on the fourth.** FR-10.1a says *every* applied action stores a before-snapshot, "agent-
initiated or human-initiated". The human rollback shipped in P2 does neither, so the gap is
already live in the product — it is not merely P4 groundwork.

---

## 2. Where the code lives, and why

```
src/mcp/
  contracts.ts     response envelope, error shapes, the `ToolResult` type
  bounded.ts       output bounding — the FR-0 caps and the 4000-char ceiling
  evidence.ts      the evidence registry (FR-6.1, FR-7.3, FR-13.5)
  audit.ts         the unified operation trail (FR-13)
  tools/readonly.ts   the twelve tool implementations, as plain functions
  register.ts      binds tool functions to document.modelContext.registerTool
  schemas.ts       JSON Schema for every tool input
```

**Every tool is a plain function of `(engine, args) → ToolResult`.** `register.ts` is a thin
binding and contains no behaviour. This is not tidiness for its own sake — it is what makes the
layer verifiable three ways:

1. **Headless tests** call the functions directly, so bounds, validation and evidence rules are
   testable in seconds.
2. **The browser console** (`window.agentops.tools`) invokes them on the live page, so each tool
   can be *seen* working before the next one is written, on a browser with no WebMCP support.
3. **The real API** — the DevTools WebMCP panel and an agent — exercises the same functions
   through `registerTool`, so a passing console check and a passing panel check cannot disagree
   about behaviour, only about registration.

Without this split, verifying a tool would require a WebMCP-enabled browser for every change.

---

## 3. Registration contract

Fixed by FR-14 and by the platform facts confirmed on 2 September 2026:

- The API is **`document.modelContext.registerTool`**. Not `navigator.modelContext` — that is the
  MCP-B polyfill's name and appears in much of the secondary writing.
- Registration runs **exactly once**, from `main.tsx`, **before** `createRoot().render()`, behind a
  module-scope flag. Registering an existing name rejects with `InvalidStateError` and does **not**
  replace the tool, so a double registration presents as a *missing* tool. React StrictMode
  double-invokes effects, which is why registration never lives in a component.
- **Top-level page only.** Tools inside iframes are never discovered on either judging surface.
- **No unregistering.** `AbortController` support is Chrome 153+; the target machine is Chrome 152.
  All twelve register at startup and stay registered; availability is expressed *inside* a tool by
  returning a refusal, never by removing it.
- **No navigation.** The app is a single page with no router; navigation destroys registered tools.
- Absence of `document.modelContext` is normal, not an error (FR-14.6). The page reports it in the
  header and remains fully usable.

Annotations: every tool here declares `readOnlyHint: true`. `search_logs` additionally declares
`untrustedContentHint: true`.

---

## 4. The response envelope

Every tool returns the same shape, serialised as JSON in a single text content block:

```jsonc
{
  "ok": true,
  "data": { /* tool-specific */ },
  "evidence_ids": ["log_0031", "log_0032"],   // ids citable in a proposal
  "truncated": false,                          // present only when bounding applied
  "returned_count": 20,                        // present only when bounding applied
  "total_count": 214,                          // present only when bounding applied
  "narrow_by": "Pass level:\"error\" or a shorter window to see fewer entries."
}
```

A refusal is the same envelope with `ok: false` and an `error` string, never an exception:

```jsonc
{ "ok": false, "error": "Unknown service \"chekout-service\". Valid services: api-gateway, …" }
```

**Refusals are instructive.** Every error names what was wrong *and* what to do instead, because
the reader is a model that cannot see the screen. A bare "invalid input" is a defect.

**`evidence_ids` is the contract that makes FR-7 possible.** Every read-only response lists the ids
it returned, and the registry records them against the calling source. A proposal citing an id that
never appears in this array, in this run, from a `source: webmcp` call, is refused in P4.

---

## 5. Evidence ids

Four of the five sources already mint stable, monotonic ids: `log_0001`, `trc_0001`, `dep_0001`,
`inc_0001`. Metrics do not, and FR-6.1 requires every response to be citable.

**Decision: `get_metrics` mints a series id, `met_0001`, per response,** and the registry stores
what it covered — service, metric, window. The alternative, a deterministic id derived from the
query, was rejected: two agents issuing the same query in different runs would produce the same id,
which would let a proposal cite evidence from a previous run and defeat FR-7.3.

Runbooks, ownership records and services carry static ids — `rb_pool_exhaustion`,
`own_checkout-service`, `svc_checkout-service` — because they are reference material, not
observations, and are identical in every run.

**Correction to an earlier draft of this document.** It exempted `list_services` from returning
ids, reasoning that an inventory is not an observation. FR-6.1 admits no exception — *"every
response includes the ids of the records returned, in a form citable as evidence"* — so the
exemption was wrong and is removed. Whether an inventory id is *good* support for a hypothesis is
a judgement for the human approver; the tool layer enforces provenance, not sufficiency, exactly
as `spec.md` says of AC-4.

### 5a. Traces expire before logs do, and the tools must say so

Measured on the live page, not reasoned about. Logs and traces are both ring buffers, but traces
are produced an order of magnitude faster, so their windows differ:

| | Produced | Buffer | Window covered |
|---|---|---|---|
| Logs | ~1.8/s | 4000 | ~38 minutes |
| Traces | ~10/s | 3000 | ~5 minutes |

The first attempt captured every failed request and sampled 2% of successes, which at 450 rps gave
~40 traces a second, a **ten-second** trace window, and **96% of correlation ids pointing at
traces that no longer existed**. Failed requests are now sampled with a per-second cap and the
success rate is lower, which brings every correlation id inside the investigation window: at 180
seconds after onset, across four seeds, **every link resolves**.

Beyond roughly five minutes they still expire, and that is left alone deliberately — every real
observability stack retains traces for less time than logs, and distorting the simulation to hide
that would be a worse lie than the limitation. It becomes a **tool contract** instead:

- `get_trace` on an id that has aged out returns an instructive refusal, never an empty result:
  *"Trace trc_00412 is no longer retained. Traces cover approximately the last 5 minutes; the log
  entry that cited it is still available."*
- `search_logs` marks each correlated entry with `trace_available: true | false`, so an agent can
  see which links are worth following before spending a call on one.

---

## 6. Output bounding

FR-0 sets a **1500-character design target** per tool output and a **4000-character hard ceiling**.
Chrome's tool-security guidance is the source of the 1500 figure.

The algorithm, in order:

1. Apply the tool's record cap from the FR-0 table (`search_logs` 20 default / 50 max, and so on).
2. Serialise. If under 1500 characters, return.
3. Drop optional fields in a fixed, documented order — trace span children beyond depth 2, then log
   `correlationId`, then deployment `summary` — and re-serialise.
4. If still over 1500, reduce the record count until it fits.
5. Set `truncated: true`, `returned_count`, `total_count`, and `narrow_by`.

**Never truncate a record part-way.** A half-serialised log line is worse than a missing one: it
invites a model to reason from a fragment. Records are dropped whole, and the count is reported.

Exceeding 4000 characters is a bug, not a degraded mode. A test asserts every tool at its maximum
parameters stays under the ceiling.

---

## 7. Input validation

FR-14.5: every tool declares typed, described parameters and validates input.

- Unknown service, metric or id → refusal naming the valid values.
- Out-of-range numeric → clamped to the maximum, and the response says so in `narrow_by`. Clamping
  beats refusing here: an agent asking for 500 log lines wants log lines, and the useful answer is
  50 of them plus a note.
- Missing required parameter → refusal naming the parameter and giving one example call.
- A time window whose start is after its end → refusal saying so.

Windows are expressed in **simulated seconds relative to now** (`window_seconds: 120`), never as
wall-clock timestamps. The agent has no reliable view of the simulated clock's origin, and relative
windows are what an on-call engineer actually asks for.

---

## 8. Untrusted content

`search_logs` returns text originating in request data. Per FR-6.2 it carries **both**
`untrustedContentHint: true` as an annotation **and** an explicit `"content_trust": "untrusted"`
field in the response body.

The annotation is advisory and nothing obliges an agent to honour it; the body field is data the
model reads directly. Carrying only the annotation would be a compliance gesture rather than a
defence.

---

## 9. The twelve tools

Descriptions are written for an agent deciding *whether to call*, and state the capability, not the
UI control. Every one names a reason an agent would reach for it.

| # | Tool | Intent | Key inputs | Evidence ids returned |
|---|---|---|---|---|
| 1 | `list_services` | Learn what exists and how it is wired before drilling in | — | `svc_*` |
| 2 | `get_service_health` | The four golden signals for one service, right now | `service` | `met_*` |
| 3 | `get_metrics` | A time series to see *when* a signal changed | `service`, `metric`, `window_seconds` | `met_*` |
| 4 | `search_logs` | Find what the service said about itself | `service?`, `level?`, `contains?`, `window_seconds?`, `limit?` | `log_*` |
| 5 | `get_trace` | See where the time went inside one request | `trace_id` | `trc_*` |
| 6 | `list_traces` | Find slow or failing requests worth opening | `service`, `slow_only?`, `errors_only?`, `limit?` | `trc_*` |
| 7 | `list_recent_deployments` | Find what changed, and when, relative to the incident | `service?`, `window_seconds?`, `limit?` | `dep_*` |
| 8 | `get_deployment_diff` | See exactly which settings a deployment altered | `deployment_id` | `dep_*` |
| 9 | `get_runbook` | Retrieve the written procedure for a symptom | `symptom?`, `service?` | `rb_*` |
| 10 | `get_service_ownership` | Find who owns a service and who is on call | `service` | `own_*` |
| 11 | `get_incident` | The current incident record and its timeline | — | `inc_*` |
| 12 | `verify_remediation` | Decide whether an applied action actually worked | `action_id?` | `met_*` |

**`get_service_health` and `get_metrics` both mint `met_*` ids.** They are different questions —
"how is it now" and "how did it get here" — and FR-4.8 requires more than one source anyway, so a
proposal cannot be built from either alone.

**`verify_remediation` is Class A.** It reads and compares and mutates nothing (FR-10.1b). Its
verdict is computed from measured metrics against the FR-0 recovery thresholds, never from which
action was taken (FR-10.2), and a failure names the signals still out of bounds (FR-10.3). With no
`action_id` it verifies the most recently applied action and says which one it verified (FR-10.1a);
an unknown `action_id` is refused with the list of valid ones.

**No tool discloses the scenario.** No name, id or category label appears in any response (FR-2.5).
The failure test stands: if an agent can name the root cause from a single call, this layer is
wrong.

---

## 10. Audit trail

FR-13.1 requires ten fields per operation. P2 records five. The full record:

`timestamp`, `kind` (`tool_call` | `ui_action`), `operation`, `source` (`webmcp` | `ui`), `actor`
(`human` | `agent`), `arguments`, `result_summary`, `duration_ms`, `status` (`ok` | `refused` |
`error`), `side_effect_class` (`A` | `B` | `C`).

Two rules that are easy to get wrong and matter:

- **`source` and `actor` are not redundant** (FR-13.1a). A human invoking a tool by hand from the
  DevTools panel is `source: webmcp, actor: human`; the page cannot tell that apart from an agent
  and must not pretend to. A dashboard click is `source: ui, actor: human` and is **not** a tool
  call.
- **Only `source: webmcp` entries count as evidence** (FR-13.5). Records a human browsed in the
  interface were never returned to the agent and cannot support the agent's citation.

Refused and failed calls are recorded with their reason (FR-13.3), never dropped. The trail also
shows which tools have not been used at all (FR-13.4).

`duration_ms` is wall-clock, and is one of the two legitimate uses of wall-clock time in the
project — the other being the 60-second approval timeout in P4.

---

## 11. Verification — per tool, not per phase

Standing rule for this build: no feature is finished until it has been *seen* working.

For each of the twelve, in order, before starting the next:

1. Unit test the function: happy path, every refusal, and the bound at maximum parameters.
2. Invoke it on the live page through the console harness and read the actual JSON.
3. Confirm the evidence ids returned are real records, and that the registry recorded them.

Then, once for the whole layer:

4. **Chrome DevTools → Application → WebMCP panel** — every tool listed with its schema, each
   invoked by hand. This is the check that proves registration, which the console cannot.
5. **Chrome with `chrome://flags/#enable-webmcp-testing`** — the path a judge without ChatGPT takes.
6. **ChatGPT desktop in-app browser** — the end-to-end agent run (this is P7's gate, not P3's).

Steps 4 and 5 need a browser flag that only Hamza can enable. Steps 1–3 do not, so the layer is
built and verified against them first, and the flag gates the sign-off rather than the work.

---

## 12. Open questions for Clarify

1. **Runbook content.** Runbooks are written English procedures. Should scenario 1's runbook name
   connection-pool exhaustion as a known failure mode with the diagnostic steps — making the
   correct diagnosis *findable but still requiring correlation* — or stay generic ("latency
   triage") so the runbook confirms rather than reveals? This directly sets how hard the puzzle is.
2. **Clamping vs refusing** on an over-range `limit` — this document chooses clamping with a note.

*(A third question, whether `list_services` should return citable ids, was withdrawn: FR-6.1
settles it. See section 5.)*
