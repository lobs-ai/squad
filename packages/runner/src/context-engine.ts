// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/context-engine.ts
// Last synced: 2026-04-23

/**
 * ContextEngine — pluggable context-window management.
 *
 * The agent loop calls `shouldCompact` before each LLM turn. When it returns
 * true, `compact` is called to reduce the message history. Swap in a custom
 * implementation via `AgentSpec.contextEngine`.
 *
 * Built-in implementations:
 * - `TruncatingContextEngine` (default) — keeps the first message and recent
 *   turns verbatim; truncates tool-result content in older messages.
 * - `NoopContextEngine` — never compacts (useful for short-lived agents or
 *   models with huge context windows like Gemini 2.0).
 */

import type { LLMMessage } from "@squad/llm";
import type { ToolRegistry } from "@squad/tools";
import {
  estimateTokens,
  shouldCompact,
  compactMessages,
  getContextLimit,
} from "./context-manager.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ContextEngine {
  /** Rough token estimate for the message array. */
  estimateTokens(messages: LLMMessage[]): number;
  /**
   * Return true when the conversation is approaching the model's context
   * limit and should be compacted before the next LLM call.
   */
  shouldCompact(messages: LLMMessage[], model: string): boolean;
  /**
   * Return a compacted copy of the message array.
   * Must never break tool_use ↔ tool_result pairing.
   */
  compact(messages: LLMMessage[]): LLMMessage[];
  /**
   * Optional: choose which tools are available for the *next* LLM call.
   *
   * Called before every LLM turn, giving the context engine full visibility
   * into the conversation so far. This is the hook for per-call dynamic tool
   * selection — for example, restricting to read-only tools after a certain
   * number of writes, or enabling a "done" tool once certain conditions are met.
   *
   * Return `undefined` to leave the tool set unchanged.
   *
   * @param messages Current conversation history (including any tool results
   *   from the previous turn).
   * @param registry The full tool registry — call `registry.names()` to
   *   enumerate available tools.
   */
  selectTools?(messages: LLMMessage[], registry: ToolRegistry): string[] | undefined;
}

// ── TruncatingContextEngine ───────────────────────────────────────────────────

/**
 * Default context engine. Keeps the task prompt and the most recent N turns
 * verbatim; truncates tool-result content in older messages to 500 chars.
 *
 * Triggers when the conversation exceeds 80% of the model's context limit.
 */
export class TruncatingContextEngine implements ContextEngine {
  /**
   * @param keepRecentTurns - Number of recent LLM turns to keep verbatim.
   *   Defaults to 5.
   * @param compactThreshold - Fraction of the context limit at which to
   *   compact (0–1). Defaults to 0.8.
   */
  constructor(
    private readonly keepRecentTurns = 5,
    private readonly compactThreshold = 0.8,
  ) {}

  estimateTokens(messages: LLMMessage[]): number {
    return estimateTokens(messages);
  }

  shouldCompact(messages: LLMMessage[], model: string): boolean {
    if (this.compactThreshold >= 1) return false;
    const limit = getContextLimit(model);
    return this.estimateTokens(messages) > limit * this.compactThreshold;
  }

  compact(messages: LLMMessage[]): LLMMessage[] {
    return compactMessages(messages, this.keepRecentTurns);
  }
}

// ── NoopContextEngine ─────────────────────────────────────────────────────────

/** Context engine that never compacts. Suitable for unlimited-context models. */
export class NoopContextEngine implements ContextEngine {
  estimateTokens(messages: LLMMessage[]): number {
    return estimateTokens(messages);
  }

  shouldCompact(_messages: LLMMessage[], _model: string): boolean {
    return false;
  }

  compact(messages: LLMMessage[]): LLMMessage[] {
    return messages;
  }
}

// ── Default instance ──────────────────────────────────────────────────────────

export const defaultContextEngine = new TruncatingContextEngine();
