# Research Findings — AgentOps Command Center

Phase 1 of the spec-driven workflow. Every claim below was read at its source before being
written down. Sources listed at the bottom.

Date: 1 Sept 2026. Deadline: 4 Sept 2026, 01:00 GMT+5.

---

## 1. The API we must use

`document.modelContext.registerTool(tool, options)` — confirmed in OpenAI's own docs and
required verbatim by the hackathon rules.

Tool fields: `name` (1–128 chars, alphanumeric plus `_ - .`), `title`, `description`,
`inputSchema` (JSON Schema), `execute`, `annotations`.

- `execute: async (input, { signal }) => result` — the result is `JSON.stringify`'d.
  **No content envelope is required**; a plain object or string is a valid return.
- Options: `signal` (AbortSignal, for unregistration) and `exposedTo` (cross-origin allowlist).
- Annotations: `readOnlyHint` and `untrustedContentHint` (both advisory).
- **Re-registering an already-registered name is rejected.** The normative draft's registration
  algorithm returns a promise rejected with an `InvalidStateError` `DOMException`; the existing tool
  is neither replaced nor updated. Register every tool exactly once, at startup.
- A `toolchange` event signals availability changes.
- Also on the interface: `getTools()`, `executeTool()`.
- Secure context only (HTTPS, or localhost for dev). Gated by the `tools` permissions policy,
  default allowlist `['self']`.

**Naming trap:** `navigator.modelContext` appears in several articles and in the MCP-B polyfill
(`@mcp-b/global`). The native standard and the hackathon requirement are `document.modelContext`.
Use `document`.

## 2. Where it runs, and what a judge will actually use

Two surfaces, and we must work in both:

| Surface | Requirement | Notes |
|---|---|---|
| ChatGPT desktop built-in browser | ChatGPT Work or Codex, GPT-5.6 Sol or Terra | Luna has WebMCP disabled. Not available on Enterprise or Edu. |
| Chrome / Edge | `chrome://flags/#enable-webmcp-testing`, Chromium 146+ | Origin trial from Chrome 149. |

**Chrome DevTools has a WebMCP panel** (Application tab). It lists registered tools, shows
invocation history and schema errors, and lets you **run any tool manually with your own input**.
This is the reliable path for a judge without ChatGPT Work, and our primary dev feedback loop.

Local machine: Chrome 152.0.7977.65, Node v20.20.2, npm 10.8.2, git 2.49. All sufficient.

## 3. Hard constraints that shape the architecture

These are not preferences. They come from OpenAI's published limitations.

- **No iframes.** ChatGPT's browser does not discover tools registered inside iframes — same-origin
  or cross-origin. Everything must register in the top-level page.
- **No declarative API on the ChatGPT surface.** Chrome *does* document a declarative API ("add
  annotations to a standard HTML form to create a WebMCP tool"), and the draft reserves a section
  for it. But ChatGPT states plainly that "tools defined through HTML form attributes aren't
  available as site tools." We must work on both surfaces, so imperative JavaScript is the only
  portable option.
- **Tools belong to the page.** Navigating away makes them unavailable. A single-page app keeps the
  tool set stable across the whole incident walkthrough; a multi-page app tears tools down on every
  navigation.
- Only Tools are supported. Resources and Prompts are not.

## 4. Human-in-the-loop: the gap we are filling

**There is no confirmation mechanism we can rely on.** The precise position, verified at source —
this is more nuanced than "the spec has none", and a judge from Chrome or the MCP-B project will
know the difference:

| Where | Status |
|---|---|
| Normative draft | No confirmation or elicitation mechanism. The string `requestUserInteraction` does not appear anywhere in it. |
| Proposal / explainer | Defines `agent.requestUserInteraction(callback)` on the object passed into `execute`, explicitly for confirming consequential actions — but on `navigator.modelContext`, the namespace the standard moved away from (see the naming trap above). No normative language obliges an agent to honour it. |
| Chrome's tool-security page | Refers to it as being "in the spec". Chrome's docs lag the draft here. |
| ChatGPT's built-in browser | Supports "a subset of the WebMCP APIs". Not documented as available. |

So a confirmation primitive is **proposed but not normative, not on the API surface we are required
to use (`document.modelContext`), and not implemented on either judging surface.**

The draft separately names this as an open gap in its security considerations: there is no
guarantee a tool's declared intent matches its behaviour, and no built-in verification for
high-privilege actions.

Meanwhile Chrome's own developer guide states the rule directly:

> "Avoid auto-submitting tools for destructive or irreversible actions unless the UI requires
> manual user confirmation outside the agent's control."

So the approval gate is a stated best practice with **no portable implementation**. Building a good
one is the project's contribution, not a workaround.

**The technique.** `execute()` is awaited by the caller, so a tool can hold its promise open until a human clicks Approve or Deny in the app's own UI. Rules that make this safe:

1. Always set a timeout (~60s) and resolve on expiry. A hanging promise blocks the agent forever.
2. Always **resolve** with an error message, never **reject**. The model can read an error string
   and recover; a rejection just fails.
3. Correlate each pending approval by a unique call id, or concurrent calls cross wires.
4. Clean up listeners and timers on settle.
5. Honour the passed `signal` so an aborted call stops waiting.

ChatGPT's browser also runs its own safety review per invocation and applies confirmation policies
for consequential actions. That is the browser's gate, layered on top of ours — not a substitute for
it, since it does not exist in the Chrome flag path.

## 5. Prior art — and where we are different

Built already: e-commerce and booking (shoe store, restaurant reservations, flight search, pizza
builder), games (maze, blackjack, mystery doors), diagramming (Excalidraw), QR and form demos, docs
search. OpenAI's showcase leads with 3D modelling and collaborative writing.

**Nothing in observability, incident response, or SRE.** The dominant pattern is "agent fills in a
form faster." AgentOps is a different shape: multi-source reasoning under a safety boundary.

Judge Alex Nahas created MCP-B, the polyfill ecosystem. Judges include Chrome, Cloudflare, Vercel,
Netlify and Shopify engineers — the implementation will be read by people who wrote the platform.

## 6. Security — a scoring opportunity

The spec names three prompt-injection vectors: poisoned tool metadata, injected tool output, and the tool implementation itself as a target. Critically, **tool return values are processed by the model as trusted information**. OpenAI states plainly that website tool definitions and results are
untrusted content.

This lands directly on our domain: **log lines are attacker-controllable text.** A log-reading tool
that returns raw log content should carry `untrustedContentHint: true`. Investigation tools should
carry `readOnlyHint: true`. Getting these right is cheap and demonstrates real understanding of the
standard.

The annotation is a **signal, not a guarantee** — nothing in the standard obliges an agent to act on
it. So pair it with an explicit `content_trust: "untrusted"` field in the response body, which the
model reads as data rather than as metadata it may silently ignore.

**Bounded output is part of the same guidance.** Chrome's tool-security page recommends a **1.5K
character limit per individual tool output**, to stay inside agent guardrails and get better
results. Unbounded log, trace and timeline responses are the obvious way to violate this, so every
read tool needs a record cap, downsampling, and explicit truncation metadata.

## 7. Stack and hosting

Everything in the product is simulated, so **no backend is required**. A static single-page app is
sufficient and satisfies both the no-iframe and stable-tools constraints.

Any of Vercel, Netlify, Cloudflare Pages or Render serve a static build over HTTPS with a public
URL. All are challenge sponsors. The choice is not load-bearing; pick one and stop thinking about it.

## 8. Risks

| Risk | Mitigation |
|---|---|
| AbortController unregistration is documented as Chrome 153+; local Chrome is 152 | Register every tool once at startup. Never depend on unregistering. Gate availability with app state instead. Re-registration is not an escape hatch either — a duplicate name is rejected with `InvalidStateError`. |
| A judge may not have ChatGPT Work | README must document the Chrome flag and DevTools panel path, with exact steps. |
| Agent invents a root cause instead of reading tool output | Tools return evidence carrying ids the agent can cite; the UI shows what was actually returned. |

## Sources

- WebMCP specification, W3C Web Machine Learning CG — https://webmachinelearning.github.io/webmcp/
- WebMCP API proposal / explainer — https://webmachinelearning.github.io/webmcp/docs/proposal.html
- Chrome WebMCP tool security — https://developer.chrome.com/docs/ai/webmcp/secure-tools
- ChatGPT site tools documentation — https://learn.chatgpt.com/docs/webmcp
- Chrome WebMCP overview — https://developer.chrome.com/docs/ai/webmcp
- Chrome imperative API — https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Chrome DevTools WebMCP panel — https://developer.chrome.com/docs/devtools/application/webmcp
- Chrome WebMCP guide — https://github.com/GoogleChrome/modern-web-guidance-src/blob/main/guides/webmcp/webmcp/guide.md
- WebMCP explainer demo — https://googlechromelabs.github.io/webmcp-tools/demos/explainer/
- awesome-webmcp — https://github.com/webfuse-com/awesome-webmcp
- Async response and HITL pattern — https://salespeak.ai/blog/webmcp-async-responses/
