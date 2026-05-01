/**
 * Memory-system LLM router.
 *
 * MemCore takes a single `LLMClient` but its per-stage model overrides
 * (`extraction_model`, `conflict_model`, …) can name models from different
 * providers than the squad's chat default. A bare `SquadLLMClientForMemCore`
 * wrapping the chat client cannot route those calls — Anthropic's client
 * doesn't speak to OpenAI, etc. This router inspects each call's `model`,
 * infers the provider, and dispatches to a per-provider `@squad/llm` client
 * built lazily from the gateway's resolved `clientConfig`.
 *
 * The chat default provider reuses the shared client so it inherits key
 * rotation, fallbacks, and cost tracking. Override providers get fresh
 * single-key clients.
 */

import {
  createClient,
  inferProvider,
  parseModelString,
  type ClientConfig,
  type LLMClient as SquadLLMClient,
} from "@squad/llm";
import type {
  CreateMessageParams as MemCoreParams,
  LLMClient as MemCoreLLMClient,
  LLMResponse as MemCoreResponse,
} from "memcore";
import { SquadLLMClientForMemCore } from "./llm-adapter.js";

export interface MemoryLLMRouterOptions {
  /**
   * Chat-default model. Calls naming this model (or any model in the same
   * provider family) route to `defaultClient` so they pick up rotation /
   * fallbacks / cost tracking from the squad's main pipeline.
   */
  defaultModel: string;
  /**
   * Shared client used for the default-provider route. When undefined, even
   * default-provider calls fall through to a freshly-built `createClient`.
   */
  defaultClient?: SquadLLMClient;
  /**
   * Resolved provider keys / base URLs (output of `resolveProviderConfig`).
   * Override-provider clients are built from this so users only configure
   * keys once, under `llm.providers`.
   */
  clientConfig: ClientConfig;
}

export class MemoryLLMRouter implements MemCoreLLMClient {
  private readonly defaultProvider: string | null;
  private readonly cache = new Map<string, SquadLLMClientForMemCore>();

  constructor(private readonly opts: MemoryLLMRouterOptions) {
    this.defaultProvider = opts.defaultModel ? inferProvider(opts.defaultModel) : null;
    if (opts.defaultClient && this.defaultProvider) {
      this.cache.set(
        this.defaultProvider,
        new SquadLLMClientForMemCore(opts.defaultClient),
      );
    }
  }

  async createMessage(params: MemCoreParams): Promise<MemCoreResponse> {
    return this.clientFor(params.model).createMessage(params);
  }

  private clientFor(model: string): SquadLLMClientForMemCore {
    const { provider } = parseModelString(model);
    const cached = this.cache.get(provider);
    if (cached) return cached;
    const built = new SquadLLMClientForMemCore(
      createClient(model, this.opts.clientConfig),
    );
    this.cache.set(provider, built);
    return built;
  }
}
