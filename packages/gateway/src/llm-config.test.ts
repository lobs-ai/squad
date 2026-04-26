import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveProviderConfig } from "./llm-config.js";

describe("resolveProviderConfig", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    // Wipe every relevant key so a real ANTHROPIC_API_KEY in dev doesn't
    // bleed into the tests.
    for (const k of Object.keys(process.env)) {
      if (k.endsWith("_API_KEY")) delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("returns empty results when no providers are configured", () => {
    const r = resolveProviderConfig({});
    expect(r.resolved).toEqual([]);
    expect(r.missingKeys).toEqual([]);
    expect(r.clientConfig.keys).toEqual({});
  });

  it("uses literal api_key when provided", () => {
    const r = resolveProviderConfig({ minimax: { api_key: "sk-test" } });
    expect(r.resolved).toEqual(["minimax"]);
    expect(r.clientConfig.keys?.minimax?.keys[0]?.key).toBe("sk-test");
    expect(r.missingKeys).toEqual([]);
  });

  it("falls back to api_key_env when literal api_key is missing", () => {
    process.env["MY_CUSTOM_KEY"] = "sk-from-env";
    const r = resolveProviderConfig({ minimax: { api_key_env: "MY_CUSTOM_KEY" } });
    expect(r.resolved).toEqual(["minimax"]);
    expect(r.clientConfig.keys?.minimax?.keys[0]?.key).toBe("sk-from-env");
  });

  it("falls back to the standard env var when neither is provided", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-claude";
    const r = resolveProviderConfig({ anthropic: {} });
    expect(r.resolved).toEqual(["anthropic"]);
    expect(r.clientConfig.keys?.anthropic?.keys[0]?.key).toBe("sk-claude");
  });

  it("flags providers configured but with no resolvable key", () => {
    const r = resolveProviderConfig({ minimax: {}, openai: {} });
    expect(r.resolved).toEqual([]);
    expect(r.missingKeys.map((m) => m.provider).sort()).toEqual(["minimax", "openai"]);
    expect(r.missingKeys[0]?.envVar).toMatch(/_API_KEY$/);
  });

  it("threads base_url into clientConfig.baseUrls", () => {
    const r = resolveProviderConfig({
      minimax: { api_key: "sk", base_url: "https://api.minimaxi.chat/v1" },
    });
    expect(r.clientConfig.baseUrls?.minimax).toBe("https://api.minimaxi.chat/v1");
  });

  it("treats local providers as resolved without a key", () => {
    const r = resolveProviderConfig({ ollama: { base_url: "http://localhost:11434/v1" } });
    expect(r.resolved).toEqual(["ollama"]);
    expect(r.missingKeys).toEqual([]);
  });

  it("synthesizes an env var name for unknown providers", () => {
    const r = resolveProviderConfig({ "weirdo-net": {} });
    expect(r.missingKeys[0]?.envVar).toBe("WEIRDO_NET_API_KEY");
  });
});
