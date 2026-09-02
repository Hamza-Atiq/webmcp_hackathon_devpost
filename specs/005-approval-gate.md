# 005 — Proposal, approval and execution (Classes B and C)

Phase 4 of the build plan, and the point at which the project becomes submittable. `003` fixed the
contracts for the twelve read-only tools; this fixes the three that change something, and the one
rule the whole product rests on: **nothing an agent proposes touches the environment until a human
clicks.**

`spec.md` remains the source of truth. This document fixes only what it leaves open — state
ownership, refusal text, how a promise is held open and settled, and where the code lives. Where
the two disagree, `spec.md` wins and this file changes.

---

## 1. What must exist before the gate is built

Found by reading the code against FR-7 to FR-9, not by recall. Each is small and each blocks
something named.

| Gap | Requirement | Blocks |
|---|---|---|
| Action names diverge from the spec | FR-9 names `scale_replicas` and `disable_feature_flag`; `actions.ts` says `scale_service` and `toggle_feature_flag` | every Class C call, by name |
| `world.flags` is always empty | FR-9.2 requires `disable_feature_flag` to be *executable* in scenario 1 and simply not help | `disable_feature_flag` |
| Only `rollback_deployment` exists | FR-9 lists five actions | four of the five |
| The registry no longer stores what a `met_*` id covered | FR-7.6 requires cited evidence to appear "in readable form" | the proposal card |

**On the second.** This is G1's argument again, and it was right the first time: an action that is
*refused* teaches an agent nothing, while an action that executes and fails to help teaches it that
its hypothesis was wrong. Feature flags are therefore seeded for every service in the baseline
world, exactly as prior deployments are, and are inert in scenario 1.

**On the fourth.** `003` §5 had the registry record what a minted metric series covered; that field
was dropped as unused while building the read-only layer. FR-7.6 is what uses it — a proposal card
showing `met_0004` tells a human nothing, and showing "p99 for checkout-service over the last 300s"
tells them what the agent actually looked at.

---

## 2. Where the code lives

```
src/engine/
  remediation.ts   the five actions, as engine operations
  flags.ts         baseline feature flags
src/mcp/
  proposals.ts     the proposal record, the state machine, evidence validation
  tools/writes.ts  propose_remediation, execute_remediation
src/ui/
  ApprovalPrompt.tsx   the pending-approval interface (FR-8.9)
  ProposalCard.tsx     hypothesis, action, blast radius, cited evidence (FR-7.6)
```

The split matters in one specific way: **the five actions are engine operations, not tool
handlers.** A human clicking "Restart service" and an agent executing an approved proposal call the
same function with the same parameters (FR-12.2). If the agent's path went through code the human's
path did not, the two could drift and the product's central claim — that this is one system a human
and an agent operate together — would quietly stop being true.

---

## 3. The proposal record

```ts
interface Proposal {
  id: string;                    // prop_0001
  createdAt: number;             // simulated ms
  status: ProposalStatus;
  hypothesis: string;            // the agent's reasoning, in its own words
  service: ServiceName;
  action: ActionKind;
  parameters: Record<string, string | number>;
  evidenceIds: string[];         // validated at creation, never re-validated later
  blastRadius: "LOW" | "MEDIUM" | "HIGH";
  decidedAt: number | null;      // simulated ms
  decisionReason: string | null; // the human's words on denial (FR-8.6)
  actionId: string | null;       // the applied action, once executed
}
```

`hypothesis` is stored and displayed and **never read by any decision**. The verdict on whether a
remediation worked is measured (FR-10.2); an agent's confidence in its own reasoning is not
evidence, and the moment the system starts treating it as evidence the approval gate becomes
theatre.

### 3a. State machine

Exactly the transitions in FR-8.0 and no others. Enforced by a single table rather than scattered
`if` statements, so an unlisted transition is impossible rather than merely unwritten:

```
pending           -> awaiting_approval | cancelled
awaiting_approval -> approved | denied | expired | cancelled
approved          -> executed
executed | denied | expired | cancelled -> (terminal)
```

`approved` exists as a distinct status from `executed` because the action is applied *after* the
human's decision is recorded. If the two were one status, a failure during application would leave
a record saying the human approved something that never happened.

---

## 4. Evidence validation — FR-7.2, FR-7.3, FR-7.4

Run once, at `propose_remediation`, in this order. The first failure returns; a caller fixing one
problem at a time learns more than one handed a list.

1. **Unknown id** — no record of it in this run: *"Evidence id "log_9999" was never returned to you
   in this run. Retrieve it first — search_logs returns log ids."* The tool that mints that prefix
   is named, because the reader cannot see the screen.
2. **Not citable** — the id exists but was only ever shown in the interface, never returned over
   WebMCP (FR-13.5): *"Evidence id "inc_0001" exists but was not returned to you — a human browsed
   it in the interface. Call get_incident yourself to cite it."*
3. **Fewer than two ids** (FR-7.2).
4. **Two ids, one source** — the most instructive failure, and the one an agent will actually hit:
   *"Both cited ids are logs. A diagnosis needs corroboration from a different kind of evidence —
   the trace a log line points at, or the deployment that preceded the change."*

A rejected proposal **is not created** (FR-8.0) and the refusal **resolves**; no tool in this system
rejects its promise (FR-7.5). The refusal is recorded in the audit trail with its reason (FR-13.3).

**Validation happens once.** A proposal whose evidence was valid at creation stays valid — evidence
is a record of what the agent had seen when it reasoned, and traces age out (`003` §5a). Re-checking
at execution time would expire proposals for a reason that has nothing to do with their merit.

---

## 5. The blocking promise — FR-8.1 to FR-8.9

`execute_remediation(proposal_id)` returns a promise that is settled by exactly one of four events,
whichever arrives first. Each settles it **once**; the rest become no-ops.

| Settled by | Status | Resolves with |
|---|---|---|
| Human clicks Approve | `approved` → `executed` | the applied `action_id` and what to do next |
| Human clicks Deny | `denied` | the human's stated reason (FR-8.6) |
| 60s wall-clock | `expired` | a timeout message naming the elapsed limit |
| Agent aborts | `cancelled` | an acknowledgement |

Rules that are easy to get wrong and matter:

- **Wall-clock, never simulated** (FR-3.5, FR-8.5). At 60x a human still gets a full real minute.
  This is the second of the project's two legitimate uses of real time, the first being
  `duration_ms` in the audit trail.
- **Approve and Deny are inactive until `awaiting_approval`** (FR-8.1a). A proposal sitting in
  `pending` has no call waiting on it, so approving it could only move it to a status
  `execute_remediation` would later refuse. Making the buttons live only while a call is open also
  puts the human's decision visibly *inside* the agent's invocation, which is the behaviour the
  whole product exists to demonstrate.
- **A second call for the same proposal is refused, not queued** (FR-8.4). Queueing would let one
  approval settle two calls.
- **Proposals never cross-resolve** (FR-8.7). Each holds its own settler, keyed by `proposal_id`.
- **Timers are cleared on every settlement path.** A timer that fires after a human approved would
  otherwise move an executed proposal to `expired`.
- **At most three proposals** may be `pending` or `awaiting_approval` at once (FR-0); a fourth is
  refused with the limit named.

---

## 6. The five actions — FR-9

Names are `spec.md`'s, not the ones currently in `actions.ts`, which change.

| Action | Blast radius | Parameters | Effect on the world |
|---|---|---|---|
| `rollback_deployment` | HIGH | — | Restores the previous version's configuration, over the rollout ramp |
| `restart_service` | MEDIUM | — | Clears heap and process state; in-flight requests fail |
| `scale_replicas` | LOW | `replicas` 1–10 | Changes replica count, altering per-replica load |
| `disable_feature_flag` | MEDIUM | `flag` | Turns a flag off, bypassing the code path it guards |
| `shift_traffic` | HIGH | `fraction` 0–1 | Reroutes that share of traffic away from the service |

Every one is **executable against every service in every scenario** (FR-2.4a's principle, applied
across the board). None may be refused for want of a target: refusal teaches nothing, execution
that fails to help teaches the hypothesis was wrong.

**P4 builds the actions and their physics; P5 proves the matrix.** FR-9.2's twenty-five outcomes are
a P5 deliverable with its own test. What P4 must not do is *special-case* any of them: each action
changes configuration and the consequences fall out of the simulation (FR-1.4). Scenario 1's row is
verified here because scenario 1 is the only mechanism that exists — `rollback_deployment` fixes it,
`scale_replicas` gives partial relief because the pool is shared (FR-9.2a), and the other three
execute and do nothing.

---

## 7. Human parity — FR-12.1

All five actions get a control in the interface, with the same parameters, in this phase. Adding
five agent actions and one human control would recreate exactly the asymmetry G3 was opened for:
the agent able to do things the human cannot. Human actions are not gated (FR-12.5) — the person
clicking is the approver — and they mint an `action_id` and a before-snapshot like any other
(FR-10.1a).

---

## 8. What the human sees

- **A pending approval is unmissable** (FR-8.9): a prominent prompt in the record column, not a
  badge. It states the action, its blast radius, the service, the hypothesis, and every cited piece
  of evidence in readable form (FR-7.6), plus a live countdown of the wall-clock timeout so the
  human knows the decision has a deadline.
- **Denial takes a reason.** FR-8.6 requires the agent to receive one, so the interface must ask for
  it rather than inventing "denied by user".
- Alarm red stays reserved for an open incident. An approval prompt is *amber* — the design language
  already uses amber for structure and attention, and a second red element would dilute the one
  signal that means something is broken.

---

## 9. Audit and evidence

`propose_remediation` is Class B, `execute_remediation` Class C, both recorded with all ten FR-13.1
fields. Two specifics:

- An approved execution records **`actor: agent`** — the agent initiated it — with the human's
  approval as part of the result summary. The human did not take the action; they permitted it.
  Flattening that into `actor: human` would erase the only distinction the product is about.
- The applied action goes on the incident timeline with its actor (FR-5.5), naming the approver.

---

## 10. Verification

Automated, added in this phase:

- `approval.test.ts` — every FR-8.0 transition, including approving a `pending` proposal (must be
  impossible), a double `execute_remediation`, the 60-second timeout, abort, denial with reason,
  and two concurrent proposals that must not cross-resolve.
- `evidence.test.ts` extensions — propose as the first call refused; single-source refused; a
  fabricated id refused; an id seen only in the interface refused (FR-7.3, AC-4).
- **The FR-8.3 failure test**: a scripted sequence of every tool in every order, asserting the world
  is unchanged without a human click. This is the one test that proves the product's core claim.

Live, in the browser, before the phase is called done:

1. The full arc: agent investigates, proposes with citations, the prompt appears, a human approves,
   the action applies, `verify_remediation` passes, the incident resolves.
2. A denial with a reason, and the agent receiving it.
3. A timeout at 60x, proving the countdown does not scale with the clock.
