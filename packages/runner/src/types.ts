// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/types.ts
// Last synced: 2026-04-23

/**
 * @agentic/runner — core types
 *
 * All public-facing interfaces for the agent execution loop.
 */

import type { LLMClient, LLMMessage, ToolDefinition } from "@squad/llm";
import type { ToolRegistry } from "@squad/tools";
import type { ContextEngine } from "./context-engine.js";
import type { Session } from "./session.js";

// ── Timeout Config ────────────────────────────────────────────────────────────

/**
 * Granular timeout config for an agent run.
 *
 * All values are in seconds. Any field may be omitted; omitted fields are
 * unbounded (except `total` and `perTool`, which fall back to library
 * defaults of 300s each).
 *
 * A run ends when *any* active timer fires. The resulting error message
 * identifies which timer tripped so callers can tell a slow tool apart
 * from a stuck LLM call or a genuinely long conversation.
 */
export interface TimeoutConfig {
  /** Overall wall-clock budget for the run. Default: 300. */
  total?: number;
  /** Budget for a single LLM turn (think → tools). No default. */
  perTurn?: number;
  /** Budget for a single tool call. Default: 300. */
  perTool?: number;
  /** Budget for a single LLM request. No default. */
  perLlmCall?: number;
}

/** Accepted shape on public APIs — a bare number means `{ total: n }`. */
export type TimeoutInput = number | TimeoutConfig;

/**
 * Normalize `TimeoutInput` to a resolved `TimeoutConfig` with defaults
 * applied. Exported so callers can introspect the final shape.
 */
export function normalizeTimeout(input: TimeoutInput | undefined): TimeoutConfig {
  if (typeof input === "number") return { total: input, perTool: 300 };
  return {
    total: input?.total ?? 300,
    perTurn: input?.perTurn,
    perTool: input?.perTool ?? 300,
    perLlmCall: input?.perLlmCall,
  };
}

// ── Agent Spec ────────────────────────────────────────────────────────────────

/**
 * Everything the runner needs to execute an agent.
 */
export interface AgentSpec {
  /** Task prompt — what the agent should do. */
  task: string;

  /** Agent type label (programmer, writer, researcher, etc.). */
  agent: string;

  /**
   * Primary model string in "provider/model-id" format. Required.
   * @example "anthropic/claude-sonnet-4-20250514"
   */
  model: string;

  /**
   * Ordered fallback models. If the primary fails with a fallback-eligible
   * error (rate limit, 5xx, timeout, network), the runner advances to the
   * next model and sticks there for the rest of this `runAgent` call. Auth
   * and invalid-request failures bypass the chain. Leave empty for no
   * fallback.
   */
  fallbacks?: string[];

  /** Working directory for exec / file operations. */
  cwd: string;

  /** Tools to make available to the agent. */
  tools: string[];

  /**
   * Timeout configuration for the run.
   *
   * Accepts either:
   * - a `number` (seconds) — treated as `total` wall-clock time (legacy shape).
   * - a `TimeoutConfig` object granting finer control:
   *   - `total`       — overall run wall clock
   *   - `perTurn`     — reset each LLM turn; fires if a single think→tool→tool
   *                     round exceeds this budget
   *   - `perTool`     — maximum seconds a single tool call may run
   *                     (replaces the previous 5-minute hardcoded cap)
   *   - `perLlmCall`  — maximum seconds a single LLM request may take
   *
   * Any subset may be provided. Omitted fields are unbounded (except the
   * library-wide defaults: `total = 300`, `perTool = 300`).
   */
  timeout: TimeoutInput;

  /** System prompt override. When omitted the runner uses a generic prompt. */
  systemPrompt?: string;

  /** Maximum LLM turns before a forced stop. Defaults to 100. */
  maxTurns?: number;

  /** Maximum tokens per LLM response. Defaults to 16384. */
  maxTokens?: number;

  /**
   * Seed the loop with an explicit message history instead of
   * the bare task prompt. Useful for resuming interrupted runs.
   */
  initialMessages?: LLMMessage[];

  /**
   * Override the LLM client. When omitted a resilient client is built
   * from `model` automatically.
   */
  clientOverride?: LLMClient;

  /**
   * Override tool execution. When omitted the built-in tool registry is used.
   * Provides a seam for injecting environment-specific tool implementations.
   */
  toolExecutor?: ToolExecutor;

  /** Arbitrary context passed into the agent (task IDs, channel IDs, notes). */
  context?: AgentContext;

  /** Callback fired on progress events (tool start/result, phase changes). */
  onProgress?: (update: ProgressUpdate) => void;

  /**
   * Called for each text token as it streams from the LLM.
   *
   * When provided, the agent loop uses the LLM client's `streamMessage`
   * method (if available) so text appears incrementally. Falls back to
   * non-streaming when the provider doesn't support it.
   *
   * Note: called for every LLM turn, not just the final response.
   * Between turns the accumulated text is reset when tool calls begin.
   *
   * @example Discord progressive message edit
   * ```ts
   * onTextChunk: (text) => updateDiscordMessage(accumulated + text),
   * ```
   */
  onTextChunk?: (text: string) => void;

  /** Model tier hint used for selecting fallback chains. */
  modelTier?: string;

  /**
   * Rewrite or sanitize assistant content blocks before they are stored
   * back into the message history. Useful for stripping extended thinking
   * blocks that must not appear in history.
   */
  sanitizeResponseContent?: (
    content: import("@squad/llm").ContentBlock[],
  ) => import("@squad/llm").ContentBlock[];

  /**
   * Tool registry to use for this run. When provided, `tools` names are
   * resolved against this registry. Falls back to the module-level registry
   * when omitted.
   */
  toolRegistry?: ToolRegistry;

  /**
   * Context engine for managing the conversation window. When omitted the
   * default `TruncatingContextEngine` is used (80% threshold, 5 recent turns).
   */
  contextEngine?: ContextEngine;

  /**
   * Shared session for message history.
   *
   * When provided, the loop reads from and writes to this session so the
   * application can observe the conversation in real time. Replaces
   * `initialMessages` — seed the session before the run instead.
   *
   * When omitted, the loop manages a private message array.
   */
  session?: Session;
}

// ── Tool Executor ─────────────────────────────────────────────────────────────

/** Signature for a custom tool executor injected via `AgentSpec.toolExecutor`. */
export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  toolUseId: string,
  cwd: string,
  context?: { channelId?: string; toolUseId?: string },
) => Promise<ToolResult>;

// ── Agent Context ─────────────────────────────────────────────────────────────

/** Structured context passed into an agent run. */
export interface AgentContext {
  taskId?: string;
  channelId?: string;
  parentTaskId?: string;
  sessionId?: string;
  workflowId?: string;
  files?: string[];
  notes?: string;
  instructions?: string;
}

// ── Result ────────────────────────────────────────────────────────────────────

/** The outcome of a completed agent run. */
export interface AgentResult {
  /** Whether the run completed successfully. */
  succeeded: boolean;
  /** Final text output from the agent (last assistant text block). */
  output: string;
  /** Error message when `succeeded` is false. */
  error?: string;
  /** Cumulative token usage across all turns. */
  usage: TokenUsage;
  /** Estimated cost in USD. */
  costUsd: number;
  /** Number of LLM turns executed. */
  turns: number;
  /** Unique run identifier (hex string). */
  runId: string;
}

// ── Token Usage ───────────────────────────────────────────────────────────────

/** Cumulative token accounting across all turns of a run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens?: number;
}

// ── Tool Result ───────────────────────────────────────────────────────────────

/** The result of executing a single tool call. */
export interface ToolResult {
  /** Must match the `id` from the LLM's tool_use block. */
  toolUseId: string;
  /** Tool output — string or structured content blocks. */
  content: string | Array<{ type: string; text?: string }>;
  /** True when the tool encountered an error. */
  is_error?: boolean;
}

// ── Tool Definition ───────────────────────────────────────────────────────────

/** A tool that can be registered in the runner's tool registry. */
export interface RunnerToolDefinition {
  definition: ToolDefinition;
  execute: (
    params: Record<string, unknown>,
    cwd: string,
  ) => Promise<{ output: string; isError?: boolean }>;
}

// ── Phase ─────────────────────────────────────────────────────────────────────

/** Current phase of the agent execution loop. */
export type AgentPhase =
  | "initializing"
  | "thinking"
  | "executing"
  | "complete"
  | "failed";

// ── Progress ──────────────────────────────────────────────────────────────────

/** A progress update fired via `AgentSpec.onProgress`. */
export interface ProgressUpdate {
  type: "tool_start" | "tool_result" | "thinking" | "phase_change";
  agentType: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: unknown;
  phase?: AgentPhase;
}

// ── Model Costs ───────────────────────────────────────────────────────────────

/** Per-million-token costs for known models. */
export const MODEL_COSTS: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Anthropic
  "claude-opus-4-20250514": { inputPerM: 15.0, outputPerM: 75.0 },
  "claude-opus-4-5": { inputPerM: 15.0, outputPerM: 75.0 },
  "claude-sonnet-4-20250514": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-sonnet-4-5": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-haiku-4-5-20251014": { inputPerM: 0.8, outputPerM: 4.0 },
  "claude-3-5-haiku-20241022": { inputPerM: 0.8, outputPerM: 4.0 },
  "claude-3-5-sonnet-20241022": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-3-7-sonnet-20250219": { inputPerM: 3.0, outputPerM: 15.0 },
  // OpenAI
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10.0 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "o1": { inputPerM: 15.0, outputPerM: 60.0 },
  "o3-mini": { inputPerM: 1.1, outputPerM: 4.4 },
  // Google
  "gemini-2.0-flash": { inputPerM: 0.1, outputPerM: 0.4 },
  "gemini-1.5-pro": { inputPerM: 1.25, outputPerM: 5.0 },
};
