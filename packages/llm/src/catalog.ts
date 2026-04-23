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
 * Return the catalog filtered to providers that have API keys (or no-key
 * local providers) configured. The filter takes the set of provider names
 * the gateway has seen in `config.llm.providers` plus the always-local set.
 */
export function listAvailableModels(configuredProviders: readonly string[]): ModelInfo[] {
  const LOCAL = new Set(["ollama", "lmstudio", "llamacpp", "vllm"]);
  const available = new Set<string>([...configuredProviders, ...LOCAL]);
  return Object.entries(MODEL_CATALOG)
    .filter(([provider]) => available.has(provider))
    .flatMap(([, models]) => models);
}

/** All models across all providers. Used when the gateway wants to be permissive. */
export function allModels(): ModelInfo[] {
  return Object.values(MODEL_CATALOG).flat();
}
