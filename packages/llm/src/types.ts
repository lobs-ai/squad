// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/llm/src/types.ts
// Last synced: 2026-04-23

/**
 * Shared types for @agentic/llm
 *
 * All public interfaces live here so consumers can import without
 * pulling in provider-specific code.
 */

// ── Token Usage ───────────────────────────────────────────────────────────────

/** Token accounting for a single LLM call. */
export interface TokenUsage {
  /** Tokens in the prompt / input. */
  inputTokens: number;
  /** Tokens generated in the response. */
  outputTokens: number;
  /** Tokens read from prompt cache (Anthropic only). */
  cacheReadTokens: number;
  /** Tokens written to prompt cache (Anthropic only). */
  cacheWriteTokens: number;
  /** Tokens spent on extended thinking (Anthropic only). */
  thinkingTokens?: number;
}

// ── Tool Types ────────────────────────────────────────────────────────────────

/**
 * JSON Schema for a tool's input parameters.
 * Mirrors the Anthropic `input_schema` format, which is also compatible
 * with OpenAI function parameter schemas.
 */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** A callable tool that can be passed to the LLM. */
export interface ToolDefinition {
  /** Tool name — must be unique within a call. */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  input_schema: ToolInputSchema;
}

// ── Message Types ─────────────────────────────────────────────────────────────

/** A single message in the conversation. */
export interface LLMMessage {
  role: "user" | "assistant";
  /**
   * String content for simple text turns.
   * Array content for rich turns (tool results, images, tool use blocks).
   */
  content: string | Array<Record<string, unknown>>;
}

// ── Response Types ────────────────────────────────────────────────────────────

/** A text block in an LLM response. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A tool call block in an LLM response. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A content block in an LLM response — either text or a tool call. */
export type ContentBlock = TextBlock | ToolUseBlock;

/** The reason the model stopped generating. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop";

/** The complete response from an LLM call. */
export interface LLMResponse {
  /** The generated content — may include text and tool calls. */
  content: ContentBlock[];
  /** Why the model stopped generating. */
  stopReason: StopReason;
  /** Token counts for this call. */
  usage: TokenUsage;
  /**
   * Extended thinking content from the model (Anthropic only).
   * Present when `thinking` was enabled in the request.
   * This text should NOT be included in message history — only in your
   * own reasoning trace. The Anthropic API strips thinking blocks
   * from message history automatically.
   */
  thinkingContent?: string;
}

// ── Thinking Config ───────────────────────────────────────────────────────────

/** Explicit thinking with a fixed token budget. */
export interface ThinkingEnabled {
  type: "enabled";
  /** Token budget for extended thinking. Minimum 1024. */
  budgetTokens: number;
}

/** Adaptive thinking — model decides how much thinking to do. */
export interface ThinkingAdaptive {
  type: "adaptive";
}

/** Thinking configuration for a request. */
export type ThinkingConfig = ThinkingEnabled | ThinkingAdaptive;

// ── Request Params ────────────────────────────────────────────────────────────

/** Parameters for a single LLM call. */
export interface CreateMessageParams {
  /** Model identifier — passed as-is to the underlying API. */
  model: string;
  /** System prompt. */
  system: string;
  /** Conversation history. */
  messages: LLMMessage[];
  /** Available tools. Pass empty array for text-only calls. */
  tools: ToolDefinition[];
  /** Maximum tokens to generate. */
  maxTokens: number;
  /**
   * Extended thinking configuration (Anthropic only).
   * Ignored for non-Anthropic providers.
   */
  thinking?: ThinkingConfig;
}

// ── Client Interface ──────────────────────────────────────────────────────────

/**
 * The core LLM client interface.
 *
 * Every provider implementation satisfies this interface, making them
 * interchangeable at call sites.
 *
 * @example
 * ```ts
 * const client: LLMClient = await createClient("anthropic/claude-sonnet-4-20250514");
 * const response = await client.createMessage({
 *   model: "claude-sonnet-4-20250514",
 *   system: "You are a helpful assistant.",
 *   messages: [{ role: "user", content: "Hello!" }],
 *   tools: [],
 *   maxTokens: 1024,
 * });
 * ```
 */
export interface LLMClient {
  createMessage(params: CreateMessageParams): Promise<LLMResponse>;
  /**
   * Stream a message, calling `onChunk` for each text delta.
   *
   * Semantically identical to `createMessage` — returns the same `LLMResponse`
   * once generation is complete. Providers that don't implement streaming
   * can leave this undefined; callers fall back to `createMessage`.
   *
   * Only text tokens are streamed. Tool-call input JSON is accumulated
   * internally and appears in the returned `LLMResponse.content` as normal.
   */
  streamMessage?(params: CreateMessageParams, onChunk: (text: string) => void): Promise<LLMResponse>;
}

// ── Provider Types ────────────────────────────────────────────────────────────

/** Supported provider identifiers. */
export type Provider =
  // ── First-party (native SDKs) ──────────────────────────────────────────────
  | "anthropic"
  | "openai"
  | "openai-codex"

  // ── Claude Code CLI subprocess (Anthropic OAuth via `claude setup-token`) ──
  | "claude-cli"

  // ── Cloud aggregators ──────────────────────────────────────────────────────
  | "openrouter"

  // ── Frontier labs (OpenAI-compatible) ─────────────────────────────────────
  | "deepseek"
  | "mistral"
  | "groq"
  | "together"
  | "xai"
  | "perplexity"
  | "fireworks"
  | "cerebras"
  | "cohere"
  | "sambanova"
  | "novita"
  | "hyperbolic"
  | "lambda"

  // ── Google ─────────────────────────────────────────────────────────────────
  | "google"

  // ── Local / self-hosted ────────────────────────────────────────────────────
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "vllm"

  // ── OpenCode subscriptions ─────────────────────────────────────────────────
  | "opencode-zen"
  | "opencode-go"

  // ── Other known ───────────────────────────────────────────────────────────
  | "z-ai"
  | "minimax"
  | "kimi"

  // ── Escape hatch for any OpenAI-compatible endpoint ────────────────────────
  | "openai-compatible";

/**
 * A resolved provider + model ID pair.
 * Produced by `parseModelString()`.
 */
export interface ProviderConfig {
  provider: Provider;
  /** The bare model ID to send to the API (no provider prefix). */
  modelId: string;
  /** Optional base URL override. */
  baseUrl?: string;
  /** Optional API key override. */
  apiKey?: string;
}

// ── Key Management ────────────────────────────────────────────────────────────

/** A single API key entry in a key pool. */
export interface KeyEntry {
  key: string;
  label?: string;
}

/** Key pool configuration — maps provider name to its key list. */
export type KeyConfig = Partial<Record<string, { keys: KeyEntry[] }>>;

// ── Circuit Breaker ───────────────────────────────────────────────────────────

/** Circuit breaker state. */
export type CircuitState = "closed" | "open" | "half-open";

/** Reason for a model failure. */
export type FailureReason = "timeout" | "session_dead" | "crash" | "empty_output";

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit. Default: 10 */
  failureThreshold: number;
  /** Minutes to wait before transitioning to half-open. Default: 30 */
  cooldownMinutes: number;
  /** Window in minutes to count failures. Default: 60 */
  windowMinutes: number;
  /** Whether circuit breaking is active. Default: true */
  enabled: boolean;
}

// ── Resilient Client Options ──────────────────────────────────────────────────

/** Options for `createResilientClient()`. */
export interface ResilientClientOptions {
  /**
   * Fallback model strings to try if the primary model fails.
   * Each is a "provider/model-id" string, same as the primary.
   *
   * @example `["openai/gpt-4.1", "anthropic/claude-haiku-4-20250514"]`
   */
  fallbackModels?: string[];
  /**
   * Maximum number of retries per model before moving to the next fallback.
   * Default: 3
   */
  maxRetries?: number;
  /**
   * Session ID for sticky key assignment.
   * Using the same session ID consistently enables prompt-cache hits
   * when you have multiple API keys.
   */
  sessionId?: string;
}

// ── Client Config ─────────────────────────────────────────────────────────────

/**
 * Configuration for `createClient()` / `createResilientClient()`.
 * All fields are optional — the client falls back to environment variables.
 */
export interface ClientConfig {
  /**
   * API keys for each provider.
   * If omitted, keys are read from environment variables:
   * - ANTHROPIC_API_KEY
   * - OPENAI_API_KEY
   * - OPENROUTER_API_KEY
   * - etc.
   */
  keys?: KeyConfig;
  /**
   * Base URL overrides per provider.
   * Useful for proxies, local models, or custom deployments.
   */
  baseUrls?: Partial<Record<Provider, string>>;
}
