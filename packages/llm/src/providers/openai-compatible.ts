// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/llm/src/providers/openai-compatible.ts
// Last synced: 2026-04-23

/**
 * OpenAI-Compatible Provider
 *
 * Generic client for any API that speaks the OpenAI Chat Completions protocol.
 * Supports LM Studio, OpenRouter, custom deployments, and hosted models.
 *
 * OpenRouter support includes:
 * - Provider routing via X-OR-* headers
 * - Automatic model path stripping (openrouter/provider/model → provider/model)
 */

import OpenAI from "openai";
import type {
  LLMClient,
  LLMResponse,
  CreateMessageParams,
} from "../types.js";
import { OpenAIClient } from "./openai.js";

// ── Known Endpoints ───────────────────────────────────────────────────────────

/**
 * Well-known base URLs for OpenAI-compatible providers.
 *
 * Add an entry here to support a new provider without any other code changes.
 * The key is the provider name used in "provider/model-id" strings.
 */
export const KNOWN_ENDPOINTS: Record<string, string> = {
  // ── Cloud aggregators ──────────────────────────────────────────────────────
  openrouter: "https://openrouter.ai/api/v1",

  // ── Frontier labs ──────────────────────────────────────────────────────────
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  xai: "https://api.x.ai/v1",
  perplexity: "https://api.perplexity.ai",
  fireworks: "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  sambanova: "https://api.sambanova.ai/v1",
  novita: "https://api.novita.ai/v3/openai",
  hyperbolic: "https://api.hyperbolic.xyz/v1",
  lambda: "https://api.lambdalabs.com/v1",

  // ── Google ─────────────────────────────────────────────────────────────────
  // Gemini via the OpenAI-compatible endpoint (uses GOOGLE_API_KEY)
  google: "https://generativelanguage.googleapis.com/v1beta/openai",

  // ── Local / self-hosted ────────────────────────────────────────────────────
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  llamacpp: "http://localhost:8080/v1",
  vllm: "http://localhost:8000/v1",

  // ── OpenCode subscriptions ─────────────────────────────────────────────────
  "opencode-zen": "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",

  // ── Other ──────────────────────────────────────────────────────────────────
  "z-ai": "https://api.z.ai/api/paas/v4",
  minimax: "https://api.minimaxi.chat/v1",
  kimi: "https://api.moonshot.cn/v1",
};

// ── OpenAI-Compatible Client ──────────────────────────────────────────────────

/** Options for constructing an OpenAICompatibleClient. */
export interface OpenAICompatibleClientOptions {
  /** API key. Some providers (LM Studio) don't require one. */
  apiKey?: string;
  /** Base URL of the API endpoint. Required. */
  baseURL: string;
  /**
   * Additional headers to send with every request.
   * OpenRouter uses these for provider routing:
   * - `X-Title: <your-app>` — identifies your app in OpenRouter dashboards
   * - `HTTP-Referer: https://...` — optional metadata
   */
  defaultHeaders?: Record<string, string>;
}

/**
 * LLM client for any OpenAI-compatible API.
 * Delegates to `OpenAIClient` with a custom base URL.
 *
 * @example LM Studio (local)
 * ```ts
 * const client = new OpenAICompatibleClient({
 *   baseURL: "http://localhost:1234/v1",
 *   apiKey: "not-needed",
 * });
 * ```
 *
 * @example OpenRouter
 * ```ts
 * const client = new OpenAICompatibleClient({
 *   baseURL: "https://openrouter.ai/api/v1",
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   defaultHeaders: { "X-Title": "My Agent" },
 * });
 * ```
 */
export class OpenAICompatibleClient implements LLMClient {
  private inner: OpenAIClient;

  constructor(options: OpenAICompatibleClientOptions) {
    this.inner = new OpenAIClient({
      apiKey: options.apiKey ?? "not-required",
      baseURL: options.baseURL,
      defaultHeaders: options.defaultHeaders,
    });
  }

  createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    return this.inner.createMessage(params);
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Options for building a client for a named compatible provider. */
export interface NamedCompatibleOptions {
  /** The short provider name (e.g. "openrouter", "lmstudio", "kimi"). */
  provider: string;
  /** API key for the provider. */
  apiKey?: string;
  /** Override the base URL (defaults to the known endpoint for this provider). */
  baseURL?: string;
  /** Additional headers. */
  defaultHeaders?: Record<string, string>;
}

/**
 * Build an `OpenAICompatibleClient` for a named provider using its
 * well-known endpoint.
 *
 * @throws if the provider has no known endpoint and no `baseURL` is provided.
 */
export function buildCompatibleClient(
  opts: NamedCompatibleOptions,
): OpenAICompatibleClient {
  const baseURL = opts.baseURL ?? KNOWN_ENDPOINTS[opts.provider];

  if (!baseURL) {
    throw new Error(
      `No known endpoint for provider "${opts.provider}". ` +
        `Pass a baseURL explicitly or add it to KNOWN_ENDPOINTS.`,
    );
  }

  return new OpenAICompatibleClient({
    apiKey: opts.apiKey,
    baseURL,
    defaultHeaders: opts.defaultHeaders,
  });
}

/**
 * Strip the "openrouter/" prefix from a model string.
 * OpenRouter model IDs are passed as-is (e.g. "anthropic/claude-sonnet-4").
 */
export function stripOpenRouterPrefix(model: string): string {
  return model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;
}
