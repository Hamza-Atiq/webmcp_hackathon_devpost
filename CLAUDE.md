# CLAUDE.md

# Constitution — AgentOps Command Center

An AI-native incident response / SRE console for the WebMCP Challenge (Devpost). It exposes
incident investigation and remediation as WebMCP tools so a human and an agent can run an
incident together. Full narrative: `Project_Story.md`.

## Principles

- **Observe → Recommend → Act.** Read-only investigation is always free to the agent. Anything
  that changes state is separated from it and gated on explicit human approval. This boundary is
  the project's core idea — never blur it for convenience.
- **Tools express business intent, not UI buttons.** Each tool is a capability an agent can reason
  about ("investigate incident", "roll back deployment"), never a one-to-one mirror of a control
  on screen. If a tool's description can't say why an agent would call it, it doesn't ship.
- **The demo scenario is deterministic.** The simulated production environment must produce the
  same incident, metrics, logs, deployments, and recovery on every load. A judge and an agent
  running it twice must see the same story.
- **The UI stays a real product, not a tool-listing page.** Judges score a coherent human
  experience alongside the WebMCP layer; the dashboard must be usable by a human who never
  invokes an agent.
- **Evidence over assertion.** A root-cause claim the agent makes must be traceable to data the
  tools actually returned.

## Constraints

- Everything is simulated in-app. No real infrastructure, no external observability vendors, no
  credentials of any kind.
- Stack and hosting are locked in `specs/` before implementation begins. Propose new dependencies;
  do not add them.

## Workflow

Spec-driven. Per feature, in order:

1. **Research** — delegate investigation to subagents so the main session stays lean.
2. **Specify** — write the spec to `specs/`. The spec is the source of truth, not the chat.
3. **Clarify** — interview me on the gaps before any implementation.
4. **Build** — plan, then task-by-task. Commit after each task so every step has a rollback point.

Use plan mode as the gate: no files are written until the spec and plan are approved.
When a spec and the code disagree, the spec wins — change the spec deliberately, in its own commit.

## Definition of done

- Behaviour matches the spec, including its edge cases.
- Verified in the browser against the live app, not just reasoned about — WebMCP tools are
  registered, discoverable, and invocable. Test in ChatGPT's in-app browser, or Chrome with
  `chrome://flags/#enable-webmcp-testing` enabled.
- The full arc runs end to end: agent investigates → explains → human approves → agent executes →
  system recovers.
- Deployed to the live URL and working there.

## Submission gates (non-negotiable)

These are graded requirements, not preferences. Nothing is "done" while one is missing.

- Live public URL a judge can open in ChatGPT's in-app browser or WebMCP-enabled Chrome.
- Public repo with all source, setup instructions, and a visible open-source license.
- Tools registered via `document.modelContext.registerTool` — the reviewers grep for it.
- Public YouTube demo, under 3 minutes, with audio, covering what it does and how WebMCP is used.
- Written description: why this fits WebMCP, how it improves the experience, what humans and
  agents can now do together that was previously hard, and how WebMCP was implemented.
