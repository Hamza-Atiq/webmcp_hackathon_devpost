# AgentOps Command Center

An AI-native incident response console where a human and an AI agent work the same live incident
together, built for the **WebMCP Challenge**.

The product exists to demonstrate one claim: *the valuable thing is not agent autonomy, it is a
clear, enforced boundary between what an agent may **observe**, what it may **recommend**, and what
it may **execute**.*

> **Status: feature-complete and deployed.** Five scenarios, sixteen WebMCP tools and the approval
> gate are live and verified in the browser; 156 tests pass. The demo video and the full write-up
> are the remaining submission items.

**Live URL:** <https://webmcp-hackathon-devpost.vercel.app>
**Demo video:** _(added at submission)_

---

## What it is

A single-page console containing a **live simulation of a small microservice system** — a seeded
clock, real traffic, and genuine cause and effect. When a bad configuration ships, the numbers
degrade *because the engine computes them that way*, not because a fixture said so. When the change
is rolled back, they recover for the same reason.

On top of that sits a WebMCP tool layer. An agent can investigate the incident across every evidence
source, must support its diagnosis with citations the app verifies, and can only change the
environment after a human clicks Approve.

A human who never opens an agent gets a fully working SRE console. That is deliberate.

## The safety model

Every tool belongs to exactly one side-effect class:

| Class | What it changes | Approval |
|---|---|---|
| **A — Observation** | Nothing | None |
| **B — Record operation** | Incident, proposal and postmortem records only | None, but audited |
| **C — Environment mutation** | The simulated production environment | **Required, always** |

**Exactly one tool is Class C** — `execute_remediation`. It is the entire surface through which
production can change, and it cannot run without a human click.

Two properties are enforced in code rather than in prose:

- **Evidence provenance.** A proposal must cite at least two evidence ids drawn from at least two
  different sources, and every id is checked against what read-only tools actually returned in this
  run. An agent that proposes a remediation as its first call is refused, with instructions.
- **Measured verification.** Whether an incident recovered is computed from metrics, never inferred
  from which action was taken. Approving a wrong fix produces a failed verification.

## Running it locally

Requires Node 20+.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine and tool-layer test suites
npm run build    # typecheck + production build
```

## Testing the WebMCP layer

Tools are registered with `document.modelContext.registerTool`. There are three ways to exercise
them, weakest to strongest:

**1. Chrome DevTools WebMCP panel** — the fast inner loop, no agent required.
Open DevTools → **Application** → **WebMCP**. Lists every registered tool, shows invocation history
and schema errors, and lets you run any tool by hand with your own input.

**2. Chrome with the testing flag** — the path for a judge without ChatGPT Work.
Enable `chrome://flags/#enable-webmcp-testing` (Chromium 146+), restart, and open the live URL.

**3. ChatGPT desktop, built-in browser** — the real end-to-end run.
Requires ChatGPT Work or Codex on GPT-5.6 Sol or Terra, with site tools enabled. Open the live URL
in the in-app browser and ask the agent to investigate the incident.

Note that tools are registered on the top-level page only — never in an iframe — because ChatGPT's
browser does not discover tools inside iframes.

## Specifications

This project was built spec-first. The specs are the source of truth, not the chat log:

| Document | Contents |
|---|---|
| [`specs/000-research.md`](specs/000-research.md) | WebMCP API research, verified at source |
| [`specs/001-system-design.md`](specs/001-system-design.md) | Architecture and rationale |
| [`specs/002-clarifications.md`](specs/002-clarifications.md) | Product decisions and their reasoning |
| [`specs/spec.md`](specs/spec.md) | **Final behavioural specification** — every requirement and acceptance criterion |

## License

[MIT](LICENSE).
