// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/tools/src/types.ts
// Last synced: 2026-04-23

/**
 * Core types for @agentic/tools
 */

/** Anthropic-compatible tool definition */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object descriptor. Must include `type: "object"`. */
  input_schema: { type: "object"; [key: string]: unknown };
  /**
   * Optional semantic tags for runtime tool selection.
   *
   * Built-in tags used by the provided tools:
   * - `"readonly"` — does not modify any state
   * - `"write"` — creates or modifies files
   * - `"exec"` — runs shell commands
   * - `"filesystem"` — operates on the local filesystem
   * - `"search"` — finds or searches content
   * - `"directory"` — works with directories
   *
   * Tags are stripped before being sent to the LLM — they are purely
   * runtime metadata for `ContextEngine.selectTools` and `registry.tagged()`.
   */
  tags?: readonly string[];
}

/** Result from a tool executor — either a plain string or a structured result with optional side effects */
export type ToolExecutorResult =
  | string
  | { result: string; sideEffects?: ToolSideEffects };

/** Side effects a tool can communicate back to the runner */
export interface ToolSideEffects {
  /** New working directory after a `cd` or workdir change */
  newCwd?: string;
}

/** Function signature for tool execution */
export type ToolExecutor = (
  params: Record<string, unknown>,
  cwd: string,
  meta?: Record<string, unknown>,
) => Promise<ToolExecutorResult>;

/** A registered tool entry */
export interface ToolEntry {
  definition: ToolDefinition;
  executor: ToolExecutor;
}
