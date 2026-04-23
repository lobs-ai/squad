import { describe, it, expect } from "vitest";
import { parseModelString, inferProvider } from "./client.js";

describe("inferProvider", () => {
  it("routes claude-* to anthropic", () => {
    expect(inferProvider("claude-sonnet-4-6")).toBe("anthropic");
  });
  it("routes gpt-* to openai", () => {
    expect(inferProvider("gpt-4o")).toBe("openai");
  });
  it("routes gemini-* to google", () => {
    expect(inferProvider("gemini-1.5-pro")).toBe("google");
  });
  it("returns null for unknown models", () => {
    expect(inferProvider("nonexistent-model-id")).toBeNull();
  });
});

describe("parseModelString", () => {
  it("parses bare claude ids", () => {
    expect(parseModelString("claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });
  it("parses explicit provider/model", () => {
    expect(parseModelString("openrouter/anthropic/claude-sonnet-4")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
  });
  it("throws on unknown prefix", () => {
    expect(() => parseModelString("unknown/model")).toThrow();
  });
});
