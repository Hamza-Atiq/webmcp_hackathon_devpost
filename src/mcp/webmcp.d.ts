/**
 * The WebMCP surface this project uses, as declared by the W3C Web ML CG draft.
 *
 * Hand-written because no lib.dom.d.ts ships it yet. Deliberately minimal: only the
 * members the app actually calls are declared, so a member that does not exist on a
 * judging surface cannot be reached for by accident and typecheck clean.
 *
 * `document.modelContext`, not `navigator.modelContext` — the latter is the MCP-B
 * polyfill's namespace and appears in much of the secondary writing. It is optional
 * because a browser without WebMCP is a supported, normal case (FR-14.6).
 */

interface WebMCPToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

interface WebMCPToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMCPToolAnnotations;
  /**
   * The return value is serialised by the agent surface; no content envelope is
   * required, so a plain object is a valid result.
   */
  execute: (input: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<unknown>;
}

interface WebMCPModelContext {
  /**
   * Rejects with `InvalidStateError` if the name is already registered, and does *not*
   * replace the existing tool — which is why registration runs exactly once (FR-14.4).
   */
  registerTool(tool: WebMCPToolDescriptor, options?: { signal?: AbortSignal }): Promise<unknown>;
  getTools?(): unknown;
}

interface Document {
  readonly modelContext?: WebMCPModelContext;
}
