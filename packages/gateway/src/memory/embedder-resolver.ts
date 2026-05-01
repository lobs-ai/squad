/**
 * Resolve an `Embedder` for the memory system using the same provider
 * config as the chat client. The embedding model name infers a provider;
 * key + base_url come from `llm.providers[<provider>]` first, then from
 * the legacy `memcore.embedding_*` fields, then from the standard env var
 * for that provider.
 *
 * Why: the original embedder construction required `OPENAI_API_KEY` even
 * when the squad ran entirely through, say, OpenRouter. Routing through
 * the same provider table the chat client uses removes the second key
 * surface and makes the embedder follow the rest of the LLM config.
 */

import { inferProvider, providerRequiresApiKey, type Provider } from "@squad/llm";
import type { Logger } from "pino";
import type { Embedder } from "memcore";

export interface EmbedderResolverInputs {
  embeddingModel: string;
  embeddingDim: number;
  /** Legacy explicit base_url for the embedder (back-compat). */
  legacyBaseUrl: string;
  /** Legacy env var name for the embedder key (back-compat). */
  legacyApiKeyEnv: string;
  /**
   * Per-provider config from the gateway's `llm.providers` table. Used to
   * pull api_key / api_key_env / base_url for the inferred provider.
   */
  providers: Record<
    string,
    {
      api_key?: string;
      api_key_env?: string;
      base_url?: string;
    }
  >;
  /** Memcore module — passed in so the gateway controls dynamic-import timing. */
  memcoreMod: {
    OpenAIEmbedder: new (opts: {
      apiKey: string;
      model: string;
      baseUrl?: string;
    }) => Embedder;
    StubEmbedder: new (dim: number, model?: string) => Embedder;
  };
  logger: Logger;
}

const STANDARD_ENV_VARS: Partial<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  xai: "XAI_API_KEY",
};

function defaultEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export type EmbedderKind = "openai" | "stub";

export interface ResolvedEmbedder {
  embedder: Embedder;
  kind: EmbedderKind;
  /** Inferred provider (may be null when the model name doesn't match any prefix). */
  provider: Provider | null;
  /** True when the resolver decided no key was needed (local provider). */
  keylessLocal: boolean;
}

export function resolveMemoryEmbedder(inputs: EmbedderResolverInputs): ResolvedEmbedder {
  const { embeddingModel, embeddingDim, providers, memcoreMod, logger } = inputs;
  const provider = inferProvider(embeddingModel);
  const providerCfg = provider ? providers[provider] : undefined;

  // Key resolution: provider literal → provider env → legacy embedding_api_key_env
  // → standard env for the provider. Try them in order.
  const candidates: Array<{ source: string; value: string | undefined }> = [
    { source: "providers.api_key", value: providerCfg?.api_key },
    {
      source: providerCfg?.api_key_env ? `providers.${providerCfg.api_key_env}` : "",
      value: providerCfg?.api_key_env ? process.env[providerCfg.api_key_env] : undefined,
    },
    {
      source: inputs.legacyApiKeyEnv,
      value: inputs.legacyApiKeyEnv ? process.env[inputs.legacyApiKeyEnv] : undefined,
    },
    {
      source: provider ? STANDARD_ENV_VARS[provider] ?? defaultEnvVar(provider) : "",
      value: provider
        ? process.env[STANDARD_ENV_VARS[provider] ?? defaultEnvVar(provider)]
        : undefined,
    },
  ];
  const picked = candidates.find((c) => c.value && c.value.trim().length > 0);

  // Base URL: legacy explicit override wins (it was set deliberately), then
  // provider-config base_url, then OpenAIEmbedder's built-in default.
  const baseUrl = inputs.legacyBaseUrl || providerCfg?.base_url || undefined;

  // "No key needed" cases:
  //   1. Inferred provider is local (ollama / lmstudio / llamacpp / vllm).
  //   2. The user explicitly set a custom base_url — they're pointing at a
  //      non-OpenAI endpoint and have chosen not to set a key, which is the
  //      typical shape of a self-hosted/local server.
  // OpenAIEmbedder requires a non-empty apiKey string, so pass a placeholder.
  const isLocalProvider = !providerRequiresApiKey(provider);
  const hasCustomBaseUrl = Boolean(baseUrl);
  const keylessLocal = !picked && (isLocalProvider || hasCustomBaseUrl);

  if (keylessLocal) {
    logger.info(
      { embeddingModel, provider, baseUrl: baseUrl ?? "default" },
      "memcore embedder resolved (local/custom endpoint — no api key needed)",
    );
    return {
      embedder: new memcoreMod.OpenAIEmbedder({
        apiKey: "not-required",
        model: embeddingModel,
        ...(baseUrl ? { baseUrl } : {}),
      }),
      kind: "openai",
      provider,
      keylessLocal: true,
    };
  }

  if (!picked) {
    logger.warn(
      {
        embeddingModel,
        provider,
        triedSources: candidates.map((c) => c.source).filter(Boolean),
      },
      "memcore embedder has no resolvable api key — using StubEmbedder (semantic recall will be degraded)",
    );
    return {
      embedder: new memcoreMod.StubEmbedder(embeddingDim, embeddingModel),
      kind: "stub",
      provider,
      keylessLocal: false,
    };
  }

  logger.info(
    { embeddingModel, provider, keySource: picked.source, baseUrl: baseUrl ?? "default" },
    "memcore embedder resolved",
  );
  return {
    embedder: new memcoreMod.OpenAIEmbedder({
      apiKey: picked.value!,
      model: embeddingModel,
      ...(baseUrl ? { baseUrl } : {}),
    }),
    kind: "openai",
    provider,
    keylessLocal: false,
  };
}
