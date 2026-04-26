/**
 * Curated catalog of popular models per provider.
 *
 * Used by the gateway to populate model-picker UIs and validate that a
 * configured `primary.model` or `fallbacks[].model` is a model the product
 * vouches for. It is NOT exhaustive — `createClient` accepts any model the
 * underlying provider recognises; the catalog is just the short list a user
 * sees by default.
 */

import type { Provider } from "./types.js";

export interface ModelInfo {
  /** Model string in `provider/model-id` format — pass directly to `createClient`. */
  id: string;
  /** Human-readable label for UIs. */
  displayName: string;
  provider: Provider;
  /** Max context window in tokens. */
  contextWindow: number;
  /** Free-form note: tier ("flagship", "cheap"), caveat ("slow"), etc. */
  notes?: string;
}

export const MODEL_CATALOG: Record<string, ModelInfo[]> = {
  anthropic: [
    { id: "anthropic/claude-opus-4-5",          displayName: "Claude Opus 4.5",     provider: "anthropic", contextWindow: 200_000, notes: "flagship" },
    { id: "anthropic/claude-sonnet-4-5",        displayName: "Claude Sonnet 4.5",   provider: "anthropic", contextWindow: 200_000, notes: "default" },
    { id: "anthropic/claude-haiku-4-5",         displayName: "Claude Haiku 4.5",    provider: "anthropic", contextWindow: 200_000, notes: "fast + cheap" },
    { id: "anthropic/claude-3-5-sonnet-20241022", displayName: "Claude 3.5 Sonnet", provider: "anthropic", contextWindow: 200_000 },
  ],
  openai: [
    { id: "openai/gpt-4o",        displayName: "GPT-4o",      provider: "openai", contextWindow: 128_000, notes: "flagship" },
    { id: "openai/gpt-4o-mini",   displayName: "GPT-4o mini", provider: "openai", contextWindow: 128_000, notes: "cheap" },
    { id: "openai/gpt-4.1",       displayName: "GPT-4.1",     provider: "openai", contextWindow: 1_000_000 },
    { id: "openai/o1",            displayName: "o1",          provider: "openai", contextWindow: 200_000, notes: "reasoning" },
    { id: "openai/o3-mini",       displayName: "o3-mini",     provider: "openai", contextWindow: 200_000, notes: "reasoning, cheap" },
  ],
  google: [
    { id: "google/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", provider: "google", contextWindow: 1_000_000, notes: "cheap + fast" },
    { id: "google/gemini-1.5-pro",   displayName: "Gemini 1.5 Pro",   provider: "google", contextWindow: 2_000_000 },
  ],
  deepseek: [
    { id: "deepseek/deepseek-chat",     displayName: "DeepSeek Chat",     provider: "deepseek", contextWindow: 64_000 },
    { id: "deepseek/deepseek-reasoner", displayName: "DeepSeek Reasoner", provider: "deepseek", contextWindow: 64_000, notes: "reasoning" },
  ],
  mistral: [
    { id: "mistral/mistral-large-latest", displayName: "Mistral Large", provider: "mistral", contextWindow: 128_000 },
    { id: "mistral/codestral-latest",     displayName: "Codestral",     provider: "mistral", contextWindow: 32_000, notes: "code" },
  ],
  groq: [
    { id: "groq/llama-3.3-70b-versatile", displayName: "Llama 3.3 70B (Groq)", provider: "groq", contextWindow: 128_000, notes: "very fast" },
    { id: "groq/qwen-2.5-coder-32b",      displayName: "Qwen 2.5 Coder 32B",   provider: "groq", contextWindow: 128_000, notes: "code" },
  ],
  xai: [
    { id: "xai/grok-2-latest", displayName: "Grok 2", provider: "xai", contextWindow: 131_072 },
  ],
  openrouter: [
    { id: "openrouter/anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5 (via OpenRouter)", provider: "openrouter", contextWindow: 200_000 },
    { id: "openrouter/openai/gpt-4o",               displayName: "GPT-4o (via OpenRouter)",            provider: "openrouter", contextWindow: 128_000 },
    { id: "openrouter/meta-llama/llama-3.3-70b-instruct", displayName: "Llama 3.3 70B (via OpenRouter)", provider: "openrouter", contextWindow: 128_000 },
  ],
  ollama: [
    { id: "ollama/llama3.3",    displayName: "Llama 3.3 (local)",   provider: "ollama", contextWindow: 128_000, notes: "local" },
    { id: "ollama/qwen2.5-coder", displayName: "Qwen 2.5 Coder (local)", provider: "ollama", contextWindow: 32_000, notes: "local, code" },
  ],
};

/**
 * Return the catalog filtered to providers the user has actually configured.
 *
 * No implicit "always show local providers" set — earlier versions silently
 * surfaced Ollama / LM Studio / llama.cpp / vLLM models even when the user
 * had only wired Anthropic. That's misleading: the dashboard then offers
 * models the gateway can't reach.
 *
 * If a provider isn't in the catalog (e.g. a custom `minimax` provider), no
 * catalog rows show up for it — that's the right call. Use {@link augmentWithExtras}
 * at the call site to splice in models that the gateway *does* know it can
 * reach (the configured primary + fallback chain) even when the catalog
 * doesn't carry them.
 */
export function listAvailableModels(configuredProviders: readonly string[]): ModelInfo[] {
  const available = new Set<string>(configuredProviders);
  return Object.entries(MODEL_CATALOG)
    .filter(([provider]) => available.has(provider))
    .flatMap(([, models]) => models);
}

/** All models across all providers. Used when the gateway wants to be permissive. */
export function allModels(): ModelInfo[] {
  return Object.values(MODEL_CATALOG).flat();
}

/**
 * Splice synthetic ModelInfo entries for any `extraIds` not already covered
 * by `models`. Provider is parsed from the leading `provider/` segment of
 * the model id (e.g. `minimax/minimax-m2.7` → provider `minimax`).
 *
 * The synthetic entry uses a 0 contextWindow as a sentinel — the dashboard
 * shows that as "—". Real catalog entries always carry a real number.
 */
export function augmentWithExtras(models: ModelInfo[], extraIds: readonly string[]): ModelInfo[] {
  const seen = new Set(models.map((m) => m.id));
  const out = [...models];
  for (const id of extraIds) {
    if (!id || seen.has(id)) continue;
    const slash = id.indexOf("/");
    const provider = slash > 0 ? id.slice(0, slash) : id;
    const name = slash > 0 ? id.slice(slash + 1) : id;
    out.push({
      id,
      displayName: name,
      provider: provider as ModelInfo["provider"],
      contextWindow: 0,
      notes: "configured",
    });
    seen.add(id);
  }
  return out;
}
