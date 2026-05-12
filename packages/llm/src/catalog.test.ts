import { describe, it, expect } from "vitest";
import { allModels, augmentWithExtras, listAvailableModels } from "./catalog.js";

describe("listAvailableModels", () => {
  it("returns nothing when no providers are configured", () => {
    expect(listAvailableModels([])).toEqual([]);
  });

  it("does NOT silently include local providers", () => {
    // Earlier behavior implicitly added ollama / lm studio / etc. That made
    // the dashboard show models the gateway couldn't actually reach.
    const result = listAvailableModels(["anthropic"]);
    expect(result.find((m) => m.provider === "ollama")).toBeUndefined();
    expect(result.find((m) => m.provider === "lmstudio")).toBeUndefined();
    expect(result.every((m) => m.provider === "anthropic")).toBe(true);
  });

  it("returns just the configured providers' models", () => {
    const result = listAvailableModels(["anthropic", "openai"]);
    const providers = new Set(result.map((m) => m.provider));
    expect(providers).toEqual(new Set(["anthropic", "openai"]));
  });

  it("ignores providers the catalog has never heard of", () => {
    // A custom provider not in the catalog returns nothing. Use
    // augmentWithExtras to splice the configured model in.
    expect(listAvailableModels(["acme-proxy"])).toEqual([]);
  });
});

describe("augmentWithExtras", () => {
  it("synthesizes ModelInfo entries for ids the catalog doesn't carry", () => {
    const out = augmentWithExtras([], ["acme-proxy/acme-fast"]);
    expect(out).toEqual([
      expect.objectContaining({
        id: "acme-proxy/acme-fast",
        displayName: "acme-fast",
        provider: "acme-proxy",
        contextWindow: 0,
        notes: "configured",
      }),
    ]);
  });

  it("doesn't duplicate ids already present", () => {
    const base = listAvailableModels(["anthropic"]);
    const out = augmentWithExtras(base, [base[0]!.id, "acme-proxy/acme-fast"]);
    const ids = out.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(out.find((m) => m.id === "acme-proxy/acme-fast")).toBeDefined();
  });

  it("ignores empty / falsy ids", () => {
    const out = augmentWithExtras([], ["", undefined as unknown as string, "acme-proxy/x"]);
    expect(out.map((m) => m.id)).toEqual(["acme-proxy/x"]);
  });
});

describe("allModels", () => {
  it("includes every catalog provider", () => {
    const providers = new Set(allModels().map((m) => m.provider));
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai")).toBe(true);
  });
});
