import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryEmbedder } from "./embedder-resolver.js";
import type { Embedder } from "memcore";

class FakeOpenAIEmbedder {
  static lastOpts: { apiKey: string; model: string; baseUrl?: string } | null = null;
  constructor(opts: { apiKey: string; model: string; baseUrl?: string }) {
    FakeOpenAIEmbedder.lastOpts = opts;
  }
  async embed(): Promise<never> {
    throw new Error("not used in tests");
  }
}

class FakeStubEmbedder {
  static lastOpts: { dim: number; model?: string } | null = null;
  constructor(dim: number, model?: string) {
    FakeStubEmbedder.lastOpts = { dim, ...(model !== undefined ? { model } : {}) };
  }
  async embed(): Promise<never> {
    throw new Error("not used in tests");
  }
}

const memcoreMod = {
  OpenAIEmbedder: FakeOpenAIEmbedder as unknown as new (opts: {
    apiKey: string;
    model: string;
    baseUrl?: string;
  }) => Embedder,
  StubEmbedder: FakeStubEmbedder as unknown as new (dim: number, model?: string) => Embedder,
};

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof resolveMemoryEmbedder>[0]["logger"];

describe("resolveMemoryEmbedder", () => {
  beforeEach(() => {
    FakeOpenAIEmbedder.lastOpts = null;
    FakeStubEmbedder.lastOpts = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses provider literal api_key when configured", () => {
    resolveMemoryEmbedder({
      embeddingModel: "text-embedding-3-large",
      embeddingDim: 3072,
      legacyBaseUrl: "",
      legacyApiKeyEnv: "OPENAI_API_KEY",
      providers: { openai: { api_key: "sk-from-config" } },
      memcoreMod,
      logger: fakeLogger,
    });
    expect(FakeOpenAIEmbedder.lastOpts).toMatchObject({
      apiKey: "sk-from-config",
      model: "text-embedding-3-large",
    });
  });

  it("falls back to provider env var, then legacy env var", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    resolveMemoryEmbedder({
      embeddingModel: "text-embedding-3-large",
      embeddingDim: 3072,
      legacyBaseUrl: "",
      legacyApiKeyEnv: "OPENAI_API_KEY",
      providers: {},
      memcoreMod,
      logger: fakeLogger,
    });
    expect(FakeOpenAIEmbedder.lastOpts?.apiKey).toBe("sk-from-env");
  });

  it("infers provider from model name and uses that provider's config", () => {
    resolveMemoryEmbedder({
      embeddingModel: "embed-english-v3.0", // cohere
      embeddingDim: 1024,
      legacyBaseUrl: "",
      legacyApiKeyEnv: "",
      providers: { cohere: { api_key: "co-key", base_url: "https://api.cohere.example" } },
      memcoreMod,
      logger: fakeLogger,
    });
    expect(FakeOpenAIEmbedder.lastOpts).toMatchObject({
      apiKey: "co-key",
      model: "embed-english-v3.0",
      baseUrl: "https://api.cohere.example",
    });
  });

  it("legacy base_url overrides provider base_url", () => {
    resolveMemoryEmbedder({
      embeddingModel: "text-embedding-3-large",
      embeddingDim: 3072,
      legacyBaseUrl: "https://override.example/v1",
      legacyApiKeyEnv: "",
      providers: { openai: { api_key: "k", base_url: "https://provider.example" } },
      memcoreMod,
      logger: fakeLogger,
    });
    expect(FakeOpenAIEmbedder.lastOpts?.baseUrl).toBe("https://override.example/v1");
  });

  it("returns StubEmbedder when no key is resolvable", () => {
    resolveMemoryEmbedder({
      embeddingModel: "text-embedding-3-large",
      embeddingDim: 3072,
      legacyBaseUrl: "",
      legacyApiKeyEnv: "DEFINITELY_NOT_SET_ENV_VAR_XYZ",
      providers: {},
      memcoreMod,
      logger: fakeLogger,
    });
    expect(FakeStubEmbedder.lastOpts).toEqual({
      dim: 3072,
      model: "text-embedding-3-large",
    });
    expect(FakeOpenAIEmbedder.lastOpts).toBeNull();
  });
});
