import { describe, it, expect, vi } from "vitest";
import { RotatingLLMClient, shouldRotateKeys } from "./rotating-client.js";
import type { CreateMessageParams, LLMClient, LLMResponse } from "@squad/llm";

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as unknown as Parameters<typeof RotatingLLMClient>[0]["logger"];

function fakeResponse(): LLMResponse {
  return {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    model: "test",
  } as unknown as LLMResponse;
}

const fakeParams = {
  model: "claude-sonnet-4-5",
  system: "",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  maxTokens: 64,
} satisfies CreateMessageParams;

describe("RotatingLLMClient", () => {
  it("round-robins across keys on success", async () => {
    const calls: string[] = [];
    const buildClient = (_p: string, k: { key: string; label: string }): LLMClient => ({
      async createMessage() {
        calls.push(k.label);
        return fakeResponse();
      },
    });
    const rc = new RotatingLLMClient({
      pools: { anthropic: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
        { key: "c", label: "C" },
      ] },
      buildClient,
      logger: stubLogger,
      inferProvider: () => "anthropic",
    });

    await rc.createMessage(fakeParams);
    await rc.createMessage(fakeParams);
    await rc.createMessage(fakeParams);
    await rc.createMessage(fakeParams);

    // Round-robin starting at index 0.
    expect(calls).toEqual(["A", "B", "C", "A"]);
  });

  it("skips a key in cooldown after a 429", async () => {
    const calls: string[] = [];
    const buildClient = (_p: string, k: { key: string; label: string }): LLMClient => ({
      async createMessage() {
        calls.push(k.label);
        if (k.label === "A") {
          const err = new Error("rate limit") as Error & { status?: number };
          err.status = 429;
          throw err;
        }
        return fakeResponse();
      },
    });
    const rc = new RotatingLLMClient({
      pools: { anthropic: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ] },
      buildClient,
      logger: stubLogger,
      inferProvider: () => "anthropic",
    });

    // First call hits A (429), rotates to B (success).
    await rc.createMessage(fakeParams);
    // Second call should skip A (still in cooldown) and hit B directly.
    await rc.createMessage(fakeParams);

    // First sequence: A (fail), B (succeed)
    // Second call: cursor advances past A (skipped because cooldown), lands on B.
    expect(calls).toEqual(["A", "B", "B"]);

    const status = rc.status();
    const aStatus = status.find((s) => s.keyLabel === "A");
    expect(aStatus?.inCooldown).toBe(true);
    expect(aStatus?.failures).toBe(1);
  });

  it("propagates non-rotatable errors immediately", async () => {
    const buildClient = (): LLMClient => ({
      async createMessage() {
        const err = new Error("invalid api key") as Error & { status?: number };
        err.status = 401;
        throw err;
      },
    });
    const rc = new RotatingLLMClient({
      pools: { anthropic: [{ key: "a", label: "A" }] },
      buildClient,
      logger: stubLogger,
      inferProvider: () => "anthropic",
    });
    await expect(rc.createMessage(fakeParams)).rejects.toThrow(/invalid api key/);
  });
});

describe("shouldRotateKeys", () => {
  it("false for empty / single-key pools", () => {
    expect(shouldRotateKeys({})).toBe(false);
    expect(shouldRotateKeys({ anthropic: [{ key: "a", label: "x" }] })).toBe(false);
  });
  it("true if any pool has 2+ keys", () => {
    expect(
      shouldRotateKeys({
        openai: [{ key: "a", label: "x" }],
        anthropic: [{ key: "a", label: "x" }, { key: "b", label: "y" }],
      }),
    ).toBe(true);
  });
});
