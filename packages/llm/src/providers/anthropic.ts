// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/llm/src/providers/anthropic.ts
// Last synced: 2026-04-23

/**
 * Anthropic Provider
 *
 * Wraps the official `@anthropic-ai/sdk` to satisfy the `LLMClient` interface.
 *
 * Features:
 * - Extended thinking (enabled/adaptive)
 * - Prompt caching via cache_control headers
 * - Tool use
 * - Full token usage reporting (cache read/write/thinking tokens)
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  CreateMessageParams,
  ContentBlock,
  TokenUsage,
  ThinkingConfig,
} from "../types.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;

function buildAnthropicMessages(messages: LLMMessage[]): AnthropicMessage[] {
  return messages.map((msg): AnthropicMessage => {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }
    // Rich content (tool results, tool use blocks, etc.) — pass through as-is
    return { role: msg.role, content: msg.content as unknown as AnthropicContent[] };
  });
}

function mapStopReason(
  reason: string | null | undefined,
): LLMResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop";
    default:
      return "end_turn";
  }
}

// ── AnthropicClient ───────────────────────────────────────────────────────────

/** Options for constructing an AnthropicClient. */
export interface AnthropicClientOptions {
  /** API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** OAuth bearer token (used instead of API key when present). */
  authToken?: string;
  /** Base URL override. */
  baseURL?: string;
}

/**
 * LLM client backed by the Anthropic Messages API.
 *
 * @example
 * ```ts
 * const client = new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY });
 * const response = await client.createMessage({
 *   model: "claude-sonnet-4-20250514",
 *   system: "You are a helpful assistant.",
 *   messages: [{ role: "user", content: "Hello!" }],
 *   tools: [],
 *   maxTokens: 1024,
 * });
 * console.log(response.content[0].type === "text" && response.content[0].text);
 * ```
 */
export class AnthropicClient implements LLMClient {
  private sdk: Anthropic;

  constructor(options: AnthropicClientOptions = {}) {
    const sdkOptions: ConstructorParameters<typeof Anthropic>[0] = {};

    if (options.baseURL) sdkOptions.baseURL = options.baseURL;

    if (options.authToken) {
      sdkOptions.authToken = options.authToken;
    } else if (options.apiKey) {
      sdkOptions.apiKey = options.apiKey;
    }
    // If neither provided, SDK reads ANTHROPIC_API_KEY from env

    this.sdk = new Anthropic(sdkOptions);
  }

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    const {
      model,
      system,
      messages,
      tools,
      maxTokens,
      thinking,
    } = params;

    // Build request body
    const requestBody: Parameters<typeof this.sdk.messages.create>[0] = {
      model,
      system,
      messages: buildAnthropicMessages(messages),
      max_tokens: maxTokens,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    };

    // Extended thinking — cast to any to set fields not in the strict SDK types
    // (thinking, betas) before the call
    const finalBody = requestBody as unknown as Record<string, unknown>;
    if (thinking) {
      if (thinking.type === "enabled") {
        finalBody.thinking = {
          type: "enabled",
          budget_tokens: thinking.budgetTokens,
        };
        // When thinking is enabled, betas must be set and temperature forced to 1
        finalBody.betas = ["interleaved-thinking-2025-05-14"];
        finalBody.temperature = 1;
      } else if (thinking.type === "adaptive") {
        finalBody.thinking = { type: "adaptive" };
        finalBody.temperature = 1;
      }
    }

    // Use non-streaming overload — cast via unknown to avoid union with Stream<>
    const raw = await (this.sdk.messages.create as unknown as (p: Record<string, unknown>) => Promise<Anthropic.Message>)(finalBody);

    // Parse content blocks
    const content: ContentBlock[] = [];
    let thinkingContent: string | undefined;

    for (const block of (raw as Anthropic.Message).content) {
      if (block.type === "thinking") {
        thinkingContent = (thinkingContent ?? "") + (block as { thinking?: string }).thinking;
      } else if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    // Parse usage
    const msg = raw as Anthropic.Message;
    const rawUsage = msg.usage as unknown as Record<string, unknown>;
    const usage: TokenUsage = {
      inputTokens: (rawUsage.input_tokens as number) ?? 0,
      outputTokens: (rawUsage.output_tokens as number) ?? 0,
      cacheReadTokens: (rawUsage.cache_read_input_tokens as number) ?? 0,
      cacheWriteTokens: (rawUsage.cache_creation_input_tokens as number) ?? 0,
    };

    return {
      content,
      stopReason: mapStopReason(msg.stop_reason),
      usage,
      ...(thinkingContent !== undefined ? { thinkingContent } : {}),
    };
  }

  async streamMessage(
    params: CreateMessageParams,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    const { model, system, messages, tools, maxTokens, thinking } = params;

    const requestBody: Record<string, unknown> = {
      model,
      system,
      messages: buildAnthropicMessages(messages),
      max_tokens: maxTokens,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    };

    if (thinking) {
      if (thinking.type === "enabled") {
        requestBody.thinking = { type: "enabled", budget_tokens: thinking.budgetTokens };
        requestBody.betas = ["interleaved-thinking-2025-05-14"];
        requestBody.temperature = 1;
      } else if (thinking.type === "adaptive") {
        requestBody.thinking = { type: "adaptive" };
        requestBody.temperature = 1;
      }
    }

    type StreamType = AsyncIterable<{ type: string; delta?: { type: string; text?: string } }> & {
      text_stream: AsyncIterable<string>;
      finalMessage(): Promise<Anthropic.Message>;
    };

    const stream = (
      this.sdk.messages.stream as unknown as (p: Record<string, unknown>) => StreamType
    )(requestBody);

    for await (const text of stream.text_stream) {
      onChunk(text);
    }

    const raw = await stream.finalMessage();
    const content: ContentBlock[] = [];
    let thinkingContent: string | undefined;

    for (const block of raw.content) {
      if (block.type === "thinking") {
        thinkingContent = (thinkingContent ?? "") + (block as { thinking?: string }).thinking;
      } else if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }

    const rawUsage = raw.usage as unknown as Record<string, unknown>;
    const usage: TokenUsage = {
      inputTokens: (rawUsage.input_tokens as number) ?? 0,
      outputTokens: (rawUsage.output_tokens as number) ?? 0,
      cacheReadTokens: (rawUsage.cache_read_input_tokens as number) ?? 0,
      cacheWriteTokens: (rawUsage.cache_creation_input_tokens as number) ?? 0,
    };

    return {
      content,
      stopReason: mapStopReason(raw.stop_reason),
      usage,
      ...(thinkingContent !== undefined ? { thinkingContent } : {}),
    };
  }
}
