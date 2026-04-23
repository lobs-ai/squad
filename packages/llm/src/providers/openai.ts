// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/llm/src/providers/openai.ts
// Last synced: 2026-04-23

/**
 * OpenAI Provider
 *
 * Wraps the official `openai` SDK to satisfy the `LLMClient` interface.
 *
 * Handles:
 * - Chat completions with tool calling
 * - Full token usage reporting
 * - Normalising OpenAI's message format to the shared LLMMessage format
 */

import OpenAI from "openai";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  CreateMessageParams,
  ContentBlock,
  TokenUsage,
} from "../types.js";
import { stripReasoning } from "../utils.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OpenAITool = OpenAI.Chat.Completions.ChatCompletionTool;

function buildOpenAIMessages(
  system: string,
  messages: LLMMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
    } else {
      // Rich content array — try to adapt tool_result blocks for OpenAI
      const blocks = msg.content as Array<Record<string, unknown>>;

      if (msg.role === "user") {
        // Check for tool_result blocks (from prior tool calls)
        const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
        const textBlocks = blocks.filter((b) => b.type === "text");

        if (toolResultBlocks.length > 0) {
          // Emit tool results as "tool" role messages
          for (const block of toolResultBlocks) {
            const content = block.content;
            const text =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? (content as Array<{ text?: string }>)
                      .map((c) => c.text ?? "")
                      .join("")
                  : String(content ?? "");

            result.push({
              role: "tool",
              tool_call_id: block.tool_use_id as string,
              content: text,
            });
          }
        }

        if (textBlocks.length > 0) {
          const text = textBlocks
            .map((b) => b.text as string)
            .join("\n");
          result.push({ role: "user", content: text });
        }
      } else if (msg.role === "assistant") {
        // Check for tool_use blocks
        const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
        const textBlocks = blocks.filter((b) => b.type === "text");

        const openAIMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: textBlocks.map((b) => b.text as string).join("\n") || null,
        };

        if (toolUseBlocks.length > 0) {
          openAIMsg.tool_calls = toolUseBlocks.map((b) => ({
            id: b.id as string,
            type: "function" as const,
            function: {
              name: b.name as string,
              arguments: JSON.stringify(b.input),
            },
          }));
        }

        result.push(openAIMsg);
      }
    }
  }

  return result;
}

function mapFinishReason(
  reason: string | null | undefined,
): LLMResponse["stopReason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

// ── OpenAIClient ──────────────────────────────────────────────────────────────

/** Options for constructing an OpenAIClient. */
export interface OpenAIClientOptions {
  /** API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Base URL override. Use for Azure OpenAI, proxies, or compatible APIs. */
  baseURL?: string;
  /** Default request headers. */
  defaultHeaders?: Record<string, string>;
}

/**
 * LLM client backed by the OpenAI Chat Completions API.
 *
 * @example
 * ```ts
 * const client = new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY });
 * const response = await client.createMessage({
 *   model: "gpt-4.1",
 *   system: "You are a helpful assistant.",
 *   messages: [{ role: "user", content: "Hello!" }],
 *   tools: [],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class OpenAIClient implements LLMClient {
  private sdk: OpenAI;

  constructor(options: OpenAIClientOptions = {}) {
    this.sdk = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
    });
  }

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    const { model, system, messages, tools, maxTokens } = params;

    const openAIMessages = buildOpenAIMessages(system, messages);

    const openAITools: OpenAITool[] = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
      },
    }));

    const completion = await this.sdk.chat.completions.create({
      model,
      messages: openAIMessages,
      max_tokens: maxTokens,
      ...(openAITools.length > 0 ? { tools: openAITools } : {}),
    });

    const choice = completion.choices[0];
    const msg = choice?.message;

    const content: ContentBlock[] = [];

    if (msg?.content) {
      content.push({ type: "text", text: stripReasoning(msg.content) });
    }

    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // Malformed JSON — leave as empty object
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    const rawUsage = completion.usage;
    const usage: TokenUsage = {
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    return {
      content,
      stopReason: mapFinishReason(choice?.finish_reason),
      usage,
    };
  }

  async streamMessage(
    params: CreateMessageParams,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    const { model, system, messages, tools, maxTokens } = params;
    const openAIMessages = buildOpenAIMessages(system, messages);
    const openAITools: OpenAITool[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
    }));

    const stream = await this.sdk.chat.completions.create({
      model,
      messages: openAIMessages,
      max_tokens: maxTokens,
      ...(openAITools.length > 0 ? { tools: openAITools } : {}),
      stream: true as const,
    });

    let textContent = "";
    let finishReason: string | null = null;
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      finishReason = choice.finish_reason ?? finishReason;

      const delta = choice.delta;
      if (delta.content) {
        textContent += delta.content;
        onChunk(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsMap.get(tc.index) ?? { id: "", name: "", args: "" };
          toolCallsMap.set(tc.index, {
            id: existing.id || tc.id || "",
            name: existing.name || tc.function?.name || "",
            args: existing.args + (tc.function?.arguments ?? ""),
          });
        }
      }

      // usage may appear in the last chunk (stream_options: include_usage)
      if ((chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage) {
        const u = (chunk as { usage: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        promptTokens = u.prompt_tokens ?? promptTokens;
        completionTokens = u.completion_tokens ?? completionTokens;
      }
    }

    const content: ContentBlock[] = [];
    if (textContent) content.push({ type: "text", text: stripReasoning(textContent) });
    for (const [, tc] of toolCallsMap) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.args); } catch { /* malformed */ }
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    const usage: TokenUsage = {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    return { content, stopReason: mapFinishReason(finishReason), usage };
  }
}
