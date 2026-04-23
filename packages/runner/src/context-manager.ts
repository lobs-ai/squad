// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/context-manager.ts
// Last synced: 2026-04-23

/**
 * Context window management.
 *
 * Tracks estimated token usage and compacts the message history when the
 * conversation approaches the model's context limit.
 *
 * Compaction strategy:
 * - Always keep the first user message (the task prompt).
 * - Keep the most recent N turns verbatim.
 * - For older turns: truncate long tool results to 500 chars.
 *
 * CRITICAL: Anthropic requires every tool_use block to have a matching
 * tool_result block immediately after. Compaction must never break that
 * pairing — we only truncate the *content* of tool_result blocks, never
 * remove them.
 */

import type { LLMMessage } from "@squad/llm";

// ── Context limits (tokens) ───────────────────────────────────────────────────

const CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  "claude-3-5": 200_000,
  "claude-3-7": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1": 128_000,
  "o3": 128_000,
  // Google
  "gemini-2": 1_000_000,
  "gemini-1.5-pro": 1_000_000,
};

const DEFAULT_CONTEXT_LIMIT = 100_000;
const COMPACT_THRESHOLD = 0.8; // compact when 80% full

/**
 * Look up the context window limit for a model string.
 */
export function getContextLimit(model: string): number {
  const modelLower = model.toLowerCase();
  for (const [prefix, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (modelLower.includes(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Estimate token count for a message array.
 * Rough heuristic: 1 token ≈ 4 characters.
 */
export function estimateTokens(messages: LLMMessage[]): number {
  const json = JSON.stringify(messages);
  return Math.ceil(json.length / 4);
}

/**
 * Returns true when the conversation is approaching the context limit
 * and should be compacted before the next LLM call.
 */
export function shouldCompact(messages: LLMMessage[], model: string): boolean {
  const limit = getContextLimit(model);
  const current = estimateTokens(messages);
  return current > limit * COMPACT_THRESHOLD;
}

/**
 * Compact the message history by truncating old tool results.
 *
 * @param messages        Current message array (mutated in-place via splice)
 * @param keepRecentTurns How many recent turns to leave untouched (default 5)
 * @returns New (shorter) message array
 */
export function compactMessages(
  messages: LLMMessage[],
  keepRecentTurns = 5,
): LLMMessage[] {
  if (messages.length <= 2) return messages;

  const compacted: LLMMessage[] = [];

  // Always keep the first message (task prompt)
  compacted.push(messages[0]);

  // The "recent" window starts here
  const recentStart = Math.max(1, messages.length - keepRecentTurns * 2);

  // Truncate tool results in old messages
  for (let i = 1; i < recentStart; i++) {
    const msg = messages[i];

    if (msg.role === "user" && Array.isArray(msg.content)) {
      const truncated = msg.content.map((block) => {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          (block as Record<string, unknown>).type === "tool_result" &&
          "content" in block
        ) {
          const raw = (block as Record<string, unknown>).content;
          const text = typeof raw === "string" ? raw : JSON.stringify(raw);
          if (text.length > 500) {
            return {
              ...(block as Record<string, unknown>),
              content: text.substring(0, 500) + "\n...[truncated]",
            };
          }
        }
        return block;
      });
      compacted.push({ ...msg, content: truncated });
    } else {
      compacted.push(msg);
    }
  }

  // Keep recent messages verbatim
  for (let i = recentStart; i < messages.length; i++) {
    compacted.push(messages[i]);
  }

  return compacted;
}
