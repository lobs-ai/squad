import type { ClientConfig, KeyConfig, Provider } from "@squad/llm";

export interface ProviderConfig {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
}

export interface ResolveProviderConfigResult {
  /** Ready-to-pass `ClientConfig` for `createClient` / `createModelChain`. */
  clientConfig: ClientConfig;
  /** Provider names that have a key (or are local and don't need one). */
  resolved: string[];
  /** Provider names that look configured but have no resolvable key. */
  missingKeys: Array<{ provider: string; envVar: string | null; reason: string }>;
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llamacpp", "vllm"]);

const FALLBACK_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  xai: "XAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  cohere: "COHERE_API_KEY",
  sambanova: "SAMBANOVA_API_KEY",
  novita: "NOVITA_API_KEY",
  hyperbolic: "HYPERBOLIC_API_KEY",
  lambda: "LAMBDA_API_KEY",
  minimax: "MINIMAX_API_KEY",
  kimi: "KIMI_API_KEY",
  "z-ai": "ZAI_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

function defaultEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * Translate the gateway's `llm.providers` config (each key is a provider
 * name, each value carries `api_key`, `api_key_env`, `base_url`) into a
 * `ClientConfig` the LLM package can consume.
 *
 * Resolution order per provider:
 *   1. literal `api_key`
 *   2. `process.env[api_key_env]`
 *   3. `process.env[STANDARD_PROVIDER_KEY_ENV]`
 *
 * Local providers (ollama, lmstudio, …) skip key resolution entirely.
 *
 * Reports providers that are configured but have no resolvable key so the
 * gateway can log a warning at boot — silent "no key wired" was the root
 * cause behind several "agent went silent" reports.
 */
export function resolveProviderConfig(
  providers: Record<string, ProviderConfig>,
): ResolveProviderConfigResult {
  const keys: KeyConfig = {};
  const baseUrls: Partial<Record<Provider, string>> = {};
  const resolved: string[] = [];
  const missingKeys: ResolveProviderConfigResult["missingKeys"] = [];

  for (const [provider, cfg] of Object.entries(providers)) {
    if (cfg.base_url) baseUrls[provider as Provider] = cfg.base_url;

    if (LOCAL_PROVIDERS.has(provider)) {
      resolved.push(provider);
      continue;
    }

    const literal = cfg.api_key;
    const envName = cfg.api_key_env ?? FALLBACK_ENV_VARS[provider] ?? defaultEnvVar(provider);
    const envValue = envName ? process.env[envName] : undefined;
    const key = literal ?? envValue;
    if (key && key.trim().length > 0) {
      keys[provider] = { keys: [{ key }] };
      resolved.push(provider);
    } else {
      missingKeys.push({
        provider,
        envVar: envName,
        reason: literal
          ? "api_key was empty"
          : envValue == null
            ? `set ${envName}=… or providers.${provider}.api_key in config.json`
            : "env var was empty",
      });
    }
  }

  return {
    clientConfig: { keys, baseUrls },
    resolved,
    missingKeys,
  };
}
