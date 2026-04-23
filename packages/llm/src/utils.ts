// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/llm/src/utils.ts
// Last synced: 2026-04-23

/**
 * Shared utilities for the @agentic/llm package.
 */

// Strips reasoning-model scratchpad blocks emitted by DeepSeek, MiniMax, GLM,
// and Kimi R-series models. Also handles unterminated trailing blocks caused
// by max_tokens truncation.
const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
const UNTERMINATED_TRAILING = /<(think|thinking|reasoning)>[\s\S]*$/i;

export function stripReasoning(text: string): string {
  return text.replace(THINK_BLOCK, "").replace(UNTERMINATED_TRAILING, "").trim();
}
