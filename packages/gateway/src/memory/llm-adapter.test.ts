import { describe, expect, it } from "vitest";
import type { CreateMessageParams as SquadParams, LLMResponse as SquadResponse, LLMClient as SquadLLMClient } from "@squad/llm";
import type { CreateMessageParams as MemCoreParams } from "memcore";
import { SquadLLMClientForMemCore } from "./llm-adapter.js";

class CapturingClient implements SquadLLMClient {
  lastParams: SquadParams | null = null;
  reply: SquadResponse = {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 1,
    },
    thinkingContent: "deliberating",
  };

  async createMessage(params: SquadParams): Promise<SquadResponse> {
    this.lastParams = params;
    return this.reply;
  }
}

describe("SquadLLMClientForMemCore", () => {
  it("renames inputSchema → input_schema and defaults missing tools to []", async () => {
    const client = new CapturingClient();
    const adapter = new SquadLLMClientForMemCore(client);

    const params: MemCoreParams = {
      model: "claude-sonnet-4-5",
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
      tools: [
        {
          name: "search",
          description: "search the docs",
          inputSchema: { properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
    };

    await adapter.createMessage(params);

    expect(client.lastParams).not.toBeNull();
    const sent = client.lastParams!;
    expect(sent.model).toBe("claude-sonnet-4-5");
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0]).toMatchObject({
      name: "search",
      description: "search the docs",
      input_schema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    });
  });

  it("preserves usage fields and forwards thinkingContent", async () => {
    const client = new CapturingClient();
    const adapter = new SquadLLMClientForMemCore(client);

    const result = await adapter.createMessage({
      model: "claude-haiku-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64,
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 1,
    });
    expect(result.thinkingContent).toBe("deliberating");
  });
});
