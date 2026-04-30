/**
 * Adapter that lets a `@squad/llm` LLMClient satisfy memcore's LLMClient
 * interface. The two contracts are intentionally close (memcore types mirror
 * `@agentic/llm`) so this is mostly field renames + tool-schema casing.
 *
 * Wiring this adapter into MemCore at boot means every memory-processing call
 * (extraction, contextualization, conflict detection, temporal parsing,
 * profile generation) flows through the same client, key pool, fallback
 * chain, and cost tracker as the squad's main agent — no second LLM config
 * to keep in sync.
 */

import type { LLMClient as SquadLLMClient } from "@squad/llm";
import type {
  CreateMessageParams as MemCoreParams,
  LLMClient as MemCoreLLMClient,
  LLMResponse as MemCoreResponse,
  ToolDefinition as MemCoreToolDefinition,
} from "memcore";

export class SquadLLMClientForMemCore implements MemCoreLLMClient {
  constructor(private readonly inner: SquadLLMClient) {}

  async createMessage(params: MemCoreParams): Promise<MemCoreResponse> {
    const tools = (params.tools ?? []).map(toSquadTool);
    const response = await this.inner.createMessage({
      model: params.model,
      system: params.system,
      messages: params.messages,
      tools,
      maxTokens: params.maxTokens,
    });
    return {
      content: response.content,
      stopReason: response.stopReason,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        ...(response.usage.thinkingTokens !== undefined
          ? { thinkingTokens: response.usage.thinkingTokens }
          : {}),
      },
      ...(response.thinkingContent !== undefined
        ? { thinkingContent: response.thinkingContent }
        : {}),
    };
  }
}

function toSquadTool(t: MemCoreToolDefinition) {
  return {
    name: t.name,
    description: t.description,
    input_schema: { type: "object" as const, ...t.inputSchema },
  };
}
