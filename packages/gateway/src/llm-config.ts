import { LOCAL_PROVIDERS, type ClientConfig, type KeyConfig, type Provider } from "@squad/llm";

export interface KeyEntryConfig {
  key?: string;
  key_env?: string;
  label?: string;
}

export interface ProviderConfig {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  /**
   * Optional pool of additional keys. Rotated round-robin by the gateway
   * RotatingLLMClient; each entry can be a literal string, `{ key }`, or
   * `{ key_env }`.
   */
  keys?: KeyEntryConfig[];
}

/**
 * Resolved key pool entry — a literal key paired with its provenance label
 * so logs/metrics can identify a misbehaving key without leaking its value.
 */
export interface ResolvedKey {
  key: string;
  label: string;
}

/** Every key pool, keyed by provider — used by the rotating LLM client. */
export type ResolvedKeyPools = Partial<Record<string, ResolvedKey[]>>;

export interface ResolveProviderConfigResult {
  /** Ready-to-pass `ClientConfig` for `createClient` / `createModelChain`. */
  clientConfig: ClientConfig;
  /** Provider names that have a key (or are local and don't need one). */
  resolved: string[];
  /** Provider names that look configured but have no resolvable key. */
  missingKeys: Array<{ provider: string; envVar: string | null; reason: string }>;
  /**
   * Full key pools per provider, in the order they should be rotated.
   * Includes the primary key plus every entry from `keys[]`. Used by
   * `RotatingLLMClient` to round-robin / 429-exclude.
   */
  keyPools: ResolvedKeyPools;
}

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
  const keyPools: ResolvedKeyPools = {};

  for (const [provider, cfg] of Object.entries(providers)) {
    if (cfg.base_url) baseUrls[provider as Provider] = cfg.base_url;

    // No-key-needed cases: known local providers, or any provider with a
    // custom base_url (self-hosted / proxy endpoints typically don't need
    // a key, and warning when it's working fine is noise).
    if (LOCAL_PROVIDERS.has(provider as Provider) || cfg.base_url) {
      resolved.push(provider);
      continue;
    }

    const envName = cfg.api_key_env ?? FALLBACK_ENV_VARS[provider] ?? defaultEnvVar(provider);
    const pool: ResolvedKey[] = [];

    // Primary key — literal first, then standard env var.
    const primary = cfg.api_key ?? (envName ? process.env[envName] : undefined);
    if (primary && primary.trim().length > 0) {
      pool.push({ key: primary, label: cfg.api_key ? "api_key" : envName ?? "primary" });
    }

    // Pool entries from keys[]: each may be literal or env-backed.
    for (let i = 0; i < (cfg.keys?.length ?? 0); i++) {
      const entry = cfg.keys![i]!;
      const literal = entry.key;
      const envValue = entry.key_env ? process.env[entry.key_env] : undefined;
      const value = literal ?? envValue;
      if (!value || value.trim().length === 0) continue;
      pool.push({
        key: value,
        label: entry.label ?? entry.key_env ?? `pool[${i}]`,
      });
    }

    if (pool.length > 0) {
      keys[provider] = { keys: pool.map((k) => ({ key: k.key, label: k.label })) };
      keyPools[provider] = pool;
      resolved.push(provider);
    } else {
      missingKeys.push({
        provider,
        envVar: envName,
        reason: cfg.api_key
          ? "api_key was empty"
          : process.env[envName] == null
            ? `set ${envName}=… or providers.${provider}.api_key in config.json`
            : "env var was empty",
      });
    }
  }

  return {
    clientConfig: { keys, baseUrls },
    resolved,
    missingKeys,
    keyPools,
  };
}
