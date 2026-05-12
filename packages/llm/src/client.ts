// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/llm/src/client.ts
// Last synced: 2026-04-23

/**
 * Client Factory
 *
 * `inferProvider()`   — infers a provider from a bare model ID (e.g. "claude-sonnet-4-6").
 * `parseModelString()` — splits "provider/model-id" strings into a ProviderConfig,
 *                        or auto-infers the provider when no prefix is given.
 * `createClient()`    — builds a bare LLMClient for a model string.
 *
 * For production use with retries/fallbacks, prefer `createResilientClient()`
 * from `resilient-client.ts`.
 */

import { AnthropicClient } from "./providers/anthropic.js";
import { OpenAIClient } from "./providers/openai.js";
import { ClaudeCliClient } from "./providers/claude-cli.js";
import {
  buildCompatibleClient,
  stripOpenRouterPrefix,
  KNOWN_ENDPOINTS,
} from "./providers/openai-compatible.js";
import type {
  LLMClient,
  ProviderConfig,
  Provider,
  ClientConfig,
} from "./types.js";

// ── inferProvider ─────────────────────────────────────────────────────────────

/**
 * Well-known model-name prefixes and their canonical providers.
 * Checked in order; first match wins. Case-insensitive.
 *
 * Add an entry here to teach the auto-router about a new model family.
 */
const MODEL_PROVIDER_PREFIXES: Array<[string, Provider]> = [
  // Anthropic
  ["claude", "anthropic"],

  // OpenAI
  ["codex-", "openai-codex"],
  ["gpt-", "openai"],
  ["o1-", "openai"],
  ["o1", "openai"],
  ["o3-", "openai"],
  ["o3", "openai"],
  ["o4-", "openai"],
  ["o4", "openai"],
  ["text-davinci", "openai"],
  ["text-embedding", "openai"],

  // Google
  ["gemini-", "google"],
  ["gemini", "google"],

  // DeepSeek
  ["deepseek-", "deepseek"],

  // Mistral / Mixtral / Codestral
  ["mistral-", "mistral"],
  ["mixtral-", "mistral"],
  ["codestral-", "mistral"],

  // Groq-hosted open models (llama, gemma, etc.)
  ["llama-", "groq"],
  ["llama3", "groq"],
  ["gemma-", "groq"],
  ["qwen-", "groq"],
  ["whisper-", "groq"],

  // xAI Grok
  ["grok-", "xai"],

  // Cohere
  ["command-", "cohere"],
  ["embed-", "cohere"],

  // Perplexity
  ["sonar-", "perplexity"],
  ["r1-", "perplexity"],

  // Local (Ollama default)
  ["ollama:", "ollama"],
];

/**
 * Infer a provider from a bare model ID such as `"claude-sonnet-4-6"` or
 * `"gpt-4o"`. Returns `null` when no prefix matches.
 *
 * Use `parseModelString` if you want automatic fallback with an error on
 * unknown model IDs.
 */
export function inferProvider(model: string): Provider | null {
  const lower = model.toLowerCase();
  for (const [prefix, provider] of MODEL_PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix)) return provider;
  }
  return null;
}

/**
 * Providers that run locally and accept any (or no) API key. Callers that
 * resolve credentials should treat these as "key not required" rather than
 * misconfigured.
 */
export const LOCAL_PROVIDERS: ReadonlySet<Provider> = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
]);

/** True when this provider runs locally and does not require an API key. */
export function providerRequiresApiKey(provider: Provider | null | undefined): boolean {
  if (!provider) return true;
  return !LOCAL_PROVIDERS.has(provider);
}

// ── parseModelString ──────────────────────────────────────────────────────────

const KNOWN_PROVIDERS: Provider[] = [
  // Native SDKs
  "anthropic",
  "openai",
  "openai-codex",
  // Claude Code CLI subprocess
  "claude-cli",
  // Cloud aggregators
  "openrouter",
  // Frontier labs
  "deepseek",
  "mistral",
  "groq",
  "together",
  "xai",
  "perplexity",
  "fireworks",
  "cerebras",
  "cohere",
  "sambanova",
  "novita",
  "hyperbolic",
  "lambda",
  // Google
  "google",
  // Local / self-hosted
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  // OpenCode
  "opencode-zen",
  "opencode-go",
  // Other
  "z-ai",
  "minimax",
  "kimi",
  // Escape hatch
  "openai-compatible",
];

/**
 * Parse a model string into a structured `ProviderConfig`.
 *
 * Accepts two formats:
 * - `"provider/model-id"` — explicit provider prefix (e.g. `"anthropic/claude-sonnet-4-6"`)
 * - `"model-id"` — bare model ID; provider is inferred from the name prefix
 *   (e.g. `"claude-sonnet-4-6"` → `anthropic`, `"gpt-4o"` → `openai`)
 *
 * @example
 * ```ts
 * parseModelString("claude-sonnet-4-6")
 * // → { provider: "anthropic", modelId: "claude-sonnet-4-6" }
 *
 * parseModelString("anthropic/claude-sonnet-4-20250514")
 * // → { provider: "anthropic", modelId: "claude-sonnet-4-20250514" }
 *
 * parseModelString("openrouter/anthropic/claude-sonnet-4")
 * // → { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }
 * ```
 *
 * @throws if the provider cannot be inferred or is not recognised.
 */
export function parseModelString(model: string): ProviderConfig {
  const slashIdx = model.indexOf("/");

  if (slashIdx === -1) {
    // No slash — try to infer provider from the model name
    const inferred = inferProvider(model);
    if (inferred) {
      return { provider: inferred, modelId: model };
    }
    throw new Error(
      `Cannot infer provider for model "${model}". ` +
        `Use "provider/model-id" format or a well-known model name ` +
        `(e.g. "claude-sonnet-4-6", "gpt-4o"). ` +
        `Known providers: ${KNOWN_PROVIDERS.join(", ")}`,
    );
  }

  const providerRaw = model.slice(0, slashIdx).toLowerCase();
  const modelId = model.slice(slashIdx + 1);

  if (!KNOWN_PROVIDERS.includes(providerRaw as Provider)) {
    throw new Error(
      `Unknown provider "${providerRaw}" in model string "${model}". ` +
        `Known providers: ${KNOWN_PROVIDERS.join(", ")}`,
    );
  }

  return { provider: providerRaw as Provider, modelId };
}

// ── createClient ──────────────────────────────────────────────────────────────

/**
 * Build a bare `LLMClient` for the given model string.
 *
 * Key lookup order:
 * 1. `config.keys[provider].keys[0]` (first key in config)
 * 2. Environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 *
 * For multi-key rotation and fallback chains, use `createResilientClient()`.
 *
 * @param model - "provider/model-id" string, e.g. "anthropic/claude-sonnet-4-20250514"
 * @param config - Optional configuration (keys, base URLs).
 *
 * @example
 * ```ts
 * const client = createClient("anthropic/claude-sonnet-4-20250514");
 * const response = await client.createMessage({
 *   model: "claude-sonnet-4-20250514",
 *   system: "You are helpful.",
 *   messages: [{ role: "user", content: "Hi!" }],
 *   tools: [],
 *   maxTokens: 512,
 * });
 * ```
 */
/**
 * Maps provider names to their environment variable for the API key.
 * Providers not listed here use the convention `<PROVIDER>_API_KEY`
 * (upper-cased, hyphens replaced with underscores).
 */
const PROVIDER_ENV_VARS: Partial<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  xai: "XAI_API_KEY",
  perplexity: "PPLX_API_KEY",
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
  "opencode-zen": "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

/** Derive the env var name for a provider using the standard convention. */
function defaultEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export function createClient(model: string, config?: ClientConfig): LLMClient {
  const { provider, modelId } = parseModelString(model);

  const getKey = (p: string): string | undefined =>
    config?.keys?.[p]?.keys?.[0]?.key;
  const getBaseUrl = (p: string): string | undefined =>
    config?.baseUrls?.[p as Provider];

  // ── Anthropic (native SDK) ────────────────────────────────────────────────
  if (provider === "anthropic") {
    return new AnthropicClient({
      apiKey: getKey("anthropic") ?? process.env.ANTHROPIC_API_KEY,
      baseURL: getBaseUrl("anthropic"),
    });
  }

  // ── Claude Code CLI (subprocess; OAuth via `claude setup-token`) ─────────
  if (provider === "claude-cli") {
    const opts = config?.providerOptions?.["claude-cli"];
    return new ClaudeCliClient({
      oauthToken: getKey("claude-cli") ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ...(opts?.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
      ...(opts?.executeTool !== undefined ? { executeTool: opts.executeTool } : {}),
    });
  }

  // ── OpenAI (native SDK) ───────────────────────────────────────────────────
  if (provider === "openai" || provider === "openai-codex") {
    return new OpenAIClient({
      apiKey: getKey("openai") ?? process.env.OPENAI_API_KEY,
      baseURL: getBaseUrl("openai"),
    });
  }

  // ── openai-compatible (explicit, requires baseURL) ────────────────────────
  if (provider === "openai-compatible") {
    const baseURL =
      getBaseUrl("openai-compatible") ??
      process.env.OPENAI_COMPATIBLE_BASE_URL;
    if (!baseURL) {
      throw new Error(
        `Provider "openai-compatible" requires a baseURL. ` +
          `Set config.baseUrls["openai-compatible"] or OPENAI_COMPATIBLE_BASE_URL.`,
      );
    }
    return buildCompatibleClient({
      provider: "openai-compatible",
      // openai-compatible always points at a custom baseURL, so a missing
      // key means "self-hosted, no auth" — pass a placeholder rather than
      // failing.
      apiKey:
        getKey("openai-compatible") ??
        process.env.OPENAI_COMPATIBLE_API_KEY ??
        "not-required",
      baseURL,
    });
  }

  // ── All remaining providers are OpenAI-compatible ─────────────────────────
  // Key resolution: config → env var from PROVIDER_ENV_VARS → convention
  const envVarName = PROVIDER_ENV_VARS[provider as Provider] ?? defaultEnvVar(provider);
  const apiKey = getKey(provider) ?? process.env[envVarName];
  const baseURL = getBaseUrl(provider);

  // No API key required for: known local providers, or any provider where
  // the user explicitly set a custom baseURL (self-hosted / proxy endpoints
  // typically don't need a key, and warning when it's working fine is noise).
  const isLocalOrCustomEndpoint = LOCAL_PROVIDERS.has(provider) || Boolean(baseURL);
  const effectiveApiKey = apiKey ?? (isLocalOrCustomEndpoint ? "not-required" : undefined);

  // OpenRouter gets an identifying header for their dashboard
  const defaultHeaders = provider === "openrouter"
    ? { "X-Title": "agentic/llm" }
    : undefined;

  return buildCompatibleClient({
    provider,
    apiKey: effectiveApiKey,
    baseURL,
    defaultHeaders,
  });
}

// ── Re-export for convenience ─────────────────────────────────────────────────

export { KNOWN_ENDPOINTS };
