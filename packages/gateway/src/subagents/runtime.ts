import type { SubagentDefinition } from "@squad/protocol";

/**
 * Runtime adapter for non-Squad-native subagents — primarily ACP-bound
 * external agents (Claude Code, Codex, Gemini CLI, Cursor, …). Plugins
 * register a runtime by id; subagent definitions opt in via `runtime: <id>`.
 *
 * The adapter handles the full life-cycle: spawn the external process,
 * stream text deltas into the supplied callback, return final output and
 * usage. The pool keeps doing what it always does — concurrency control,
 * session bookkeeping, broadcast event publishing — so external runtimes
 * appear in the dashboard / Discord / CLI exactly like native subagents.
 */
export interface SubagentRuntimeRunInput {
  /** Concatenated initial user content (prompt + JSON-stringified input). */
  prompt: string;
  /** Resolved model from the definition or the per-spawn override. */
  model: string;
  /** Tool ids the subagent is allowed to use — runtime-specific interpretation. */
  allowedTools: string[];
  /** Working directory; runtimes that exec subprocess inherit this. */
  cwd: string;
  /** Definition the spawn was resolved from. */
  definition: SubagentDefinition;
  /** Per-call signal that a parent has cancelled the spawn. */
  signal: AbortSignal;
  /** Stream text deltas back to the gateway broadcast bus. */
  onTextChunk?: (delta: string) => void;
}

export interface SubagentRuntimeRunResult {
  output: string;
  succeeded: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Optional structured details — surfaced to the parent on completion. */
  detail?: Record<string, unknown>;
}

export interface SubagentRuntime {
  id: string;
  run(input: SubagentRuntimeRunInput): Promise<SubagentRuntimeRunResult>;
}

/**
 * Runtime registry. The gateway boot wires one of these and threads it into
 * the SubagentPool; plugins of kind "subagent" can either register a
 * definition (native runtime) or register a runtime adapter (external).
 */
export class SubagentRuntimeRegistry {
  private readonly byId = new Map<string, SubagentRuntime>();

  register(runtime: SubagentRuntime): void {
    this.byId.set(runtime.id, runtime);
  }

  get(id: string): SubagentRuntime | undefined {
    return this.byId.get(id);
  }

  list(): string[] {
    return Array.from(this.byId.keys());
  }
}
