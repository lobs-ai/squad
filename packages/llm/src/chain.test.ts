import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createModelChain } from "./chain.js";
import type { LLMClient, LLMResponse, CreateMessageParams } from "./types.js";

// We test the chain's *behavior* around errors, not the provider SDKs. To do
// that we stub `createClient` so each model string resolves to a fake client
// we control. The fakes throw whatever the test wants.

const fakeClients = new Map<string, LLMClient>();

vi.mock("./client.js", async (importActual) => {
  const actual = await importActual<typeof import("./client.js")>();
  return {
    ...actual,
    createClient: (model: string): LLMClient => {
      const client = fakeClients.get(model);
      if (!client) throw new Error(`test: no fake registered for ${model}`);
      return client;
    },
    parseModelString: (model: string) => {
      const [provider, ...rest] = model.split("/");
      return { provider: (provider ?? model) as never, modelId: rest.length ? rest.join("/") : model };
    },
  };
});

function ok(text = "hi"): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function httpError(status: number, message = "boom"): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeClient(create: (p: CreateMessageParams) => Promise<LLMResponse>): LLMClient {
  return { createMessage: create };
}

beforeEach(() => {
  fakeClients.clear();
});
afterEach(() => {
  fakeClients.clear();
});

describe("createModelChain", () => {
  it("uses the primary when it succeeds", async () => {
    fakeClients.set("anthropic/primary", makeClient(async () => ok("from-primary")));
    fakeClients.set("openai/fallback", makeClient(async () => ok("from-fallback")));

    const chain = createModelChain({
      primary: "anthropic/primary",
      fallbacks: ["openai/fallback"],
    });

    const res = await chain.createMessage({
      model: "ignored",
      system: "s",
      messages: [],
      tools: [],
      maxTokens: 10,
    });
    expect((res.content[0] as { text: string }).text).toBe("from-primary");
    expect(chain.currentModel()).toBe("anthropic/primary");
  });

  it("advances to fallback on 429 (rate_limit) and sticks", async () => {
    const primary = vi.fn().mockRejectedValue(httpError(429, "rate limited"));
    const fallback = vi.fn().mockResolvedValue(ok("from-fallback"));

    fakeClients.set("anthropic/primary", makeClient(primary));
    fakeClients.set("openai/fallback", makeClient(fallback));

    const onFallback = vi.fn();
    const chain = createModelChain({
      primary: "anthropic/primary",
      fallbacks: ["openai/fallback"],
      onFallback,
    });

    const r1 = await chain.createMessage({
      model: "x", system: "s", messages: [], tools: [], maxTokens: 10,
    });
    expect((r1.content[0] as { text: string }).text).toBe("from-fallback");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0].from).toBe("anthropic/primary");
    expect(onFallback.mock.calls[0][0].to).toBe("openai/fallback");
    expect(chain.currentModel()).toBe("openai/fallback");

    // Second call: primary must NOT be tried again (sticky).
    const r2 = await chain.createMessage({
      model: "x", system: "s", messages: [], tools: [], maxTokens: 10,
    });
    expect((r2.content[0] as { text: string }).text).toBe("from-fallback");
    expect(primary).toHaveBeenCalledTimes(1); // unchanged after first failure
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("bubbles up invalid_request (non-fallback-eligible) immediately", async () => {
    const primary = vi.fn().mockRejectedValue(httpError(400, "bad tool schema"));
    const fallback = vi.fn().mockResolvedValue(ok("unreachable"));

    fakeClients.set("anthropic/primary", makeClient(primary));
    fakeClients.set("openai/fallback", makeClient(fallback));

    const chain = createModelChain({
      primary: "anthropic/primary",
      fallbacks: ["openai/fallback"],
    });

    await expect(
      chain.createMessage({ model: "x", system: "s", messages: [], tools: [], maxTokens: 10 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fallback).not.toHaveBeenCalled();
    expect(chain.currentModel()).toBe("anthropic/primary"); // did NOT advance
  });

  it("exhausts the chain and rethrows the last error", async () => {
    fakeClients.set("a/1", makeClient(vi.fn().mockRejectedValue(httpError(429))));
    fakeClients.set("b/2", makeClient(vi.fn().mockRejectedValue(httpError(500))));
    fakeClients.set("c/3", makeClient(vi.fn().mockRejectedValue(httpError(503, "last"))));

    const chain = createModelChain({ primary: "a/1", fallbacks: ["b/2", "c/3"] });
    await expect(
      chain.createMessage({ model: "x", system: "s", messages: [], tools: [], maxTokens: 10 }),
    ).rejects.toThrow(/last/);
  });

  it("delegates streamMessage and still sticks on fallback", async () => {
    const primary: LLMClient = {
      createMessage: async () => { throw httpError(429); },
      streamMessage: async () => { throw httpError(429); },
    };
    const fallbackStream = vi.fn(async (_p: CreateMessageParams, onChunk: (t: string) => void) => {
      onChunk("hel");
      onChunk("lo");
      return ok("hello");
    });
    const fallback: LLMClient = {
      createMessage: async () => ok("hello"),
      streamMessage: fallbackStream,
    };
    fakeClients.set("a/1", primary);
    fakeClients.set("b/2", fallback);

    const chain = createModelChain({ primary: "a/1", fallbacks: ["b/2"] });
    const chunks: string[] = [];
    const res = await chain.streamMessage!(
      { model: "x", system: "s", messages: [], tools: [], maxTokens: 10 },
      (t) => chunks.push(t),
    );
    expect(chunks).toEqual(["hel", "lo"]);
    expect((res.content[0] as { text: string }).text).toBe("hello");
    expect(chain.currentModel()).toBe("b/2");
  });

  it("throws when primary is missing", () => {
    expect(() => createModelChain({ primary: "" })).toThrow(/primary is required/);
  });

  it("exposes the resolved chain via models()", () => {
    fakeClients.set("a/1", makeClient(async () => ok()));
    fakeClients.set("b/2", makeClient(async () => ok()));
    const chain = createModelChain({ primary: "a/1", fallbacks: ["b/2"] });
    expect(chain.models()).toEqual(["a/1", "b/2"]);
  });
});
