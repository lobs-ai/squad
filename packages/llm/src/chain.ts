/**
 * Sticky model chain — primary + ordered fallbacks, per-session sticky.
 *
 * `createModelChain` returns an `LLMClient` that tries the primary model
 * first; if that fails with a fallback-eligible error, it advances to the
 * next model in the chain *and stays there* for every subsequent call.
 * Once a fallback wins, the chain never drops back to the primary. That
 * makes each session's model selection observable (sessions pinned to the
 * same model the whole way through) and avoids the thundering-herd of
 * every turn re-probing a degraded primary.
 *
 * Errors that indicate a caller bug (invalid request, tool schema
 * mismatch) are NOT fallback-eligible and bubble up immediately — see
 * `classifyError` for the policy.
 *
 * Callers construct the chain once per session and reuse the returned
 * client across turns. Stickiness is just the `currentIndex` captured in
 * the closure below.
 */

import type { ClientConfig, LLMClient, CreateMessageParams, LLMResponse } from "./types.js";
import { createClient, parseModelString } from "./client.js";
import { classifyError, type ClassifiedError } from "./errors.js";

export interface ModelChainConfig {
  /** Primary model string ("provider/model-id" or bare). Required. */
  primary: string;
  /** Ordered list of fallback models tried when primary fails. */
  fallbacks?: string[];
  /**
   * Per-provider keys + base URLs threaded through to every slot's
   * underlying client. Without this, the chain would build clients with
   * just env-var fallbacks — which silently fails when callers configure
   * keys via JSON instead of `process.env`.
   */
  config?: ClientConfig;
  /**
   * Called when the chain advances to a new model. Useful for logging /
   * surfacing the change in the dashboard.
   */
  onFallback?: (event: {
    from: string;
    to: string;
    error: ClassifiedError;
  }) => void;
}

/**
 * Internal: one slot in the resolved chain. Each slot owns its own
 * underlying client so a sticky session isn't rebuilding clients per call.
 */
interface Slot {
  model: string;
  modelId: string;
  client: LLMClient;
}

export interface ModelChain extends LLMClient {
  /** The model that's currently being used (primary or whichever fallback won). */
  currentModel(): string;
  /** The full resolved chain in try-order, for observability. */
  models(): readonly string[];
}

export function createModelChain(cfg: ModelChainConfig): ModelChain {
  const all = [cfg.primary, ...(cfg.fallbacks ?? [])].filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
  if (all.length === 0) {
    throw new Error("createModelChain: primary is required");
  }

  // Build all slots up front so configuration errors surface at construction
  // time rather than on the first fallback (which might be seconds into a run).
  const slots: Slot[] = all.map((model) => {
    const parsed = parseModelString(model);
    return { model, modelId: parsed.modelId, client: createClient(model, cfg.config) };
  });

  let currentIndex = 0;

  /**
   * Call `fn` on the current slot; advance on fallback-eligible errors.
   * Never goes backwards — once we've moved to slot N we stay at >= N.
   */
  async function callWithChain<T>(
    fn: (slot: Slot) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    while (currentIndex < slots.length) {
      const slot = slots[currentIndex]!;
      try {
        return await fn(slot);
      } catch (err) {
        lastError = err;
        const classified = classifyError(err);
        if (!classified.eligibleForFallback || currentIndex === slots.length - 1) {
          // Either the error is the caller's bug, or we've exhausted the chain.
          throw err;
        }
        const previous = slot.model;
        currentIndex++;
        const next = slots[currentIndex]!;
        cfg.onFallback?.({ from: previous, to: next.model, error: classified });
      }
    }
    // Unreachable — the loop either returns or throws — but TS wants it.
    throw lastError instanceof Error
      ? lastError
      : new Error("Model chain exhausted with no error");
  }

  return {
    currentModel: () => slots[currentIndex]!.model,
    models: () => slots.map((s) => s.model),

    async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
      return callWithChain((slot) =>
        slot.client.createMessage({ ...params, model: slot.modelId }),
      );
    },

    async streamMessage(
      params: CreateMessageParams,
      onChunk: (text: string) => void,
    ): Promise<LLMResponse> {
      return callWithChain(async (slot) => {
        if (slot.client.streamMessage) {
          // If the stream starts emitting deltas and *then* errors, the
          // caller has already received partial text from the failing model.
          // We don't rewind it — the agent loop treats a failed stream the
          // same as a failed non-stream call and re-runs the turn at the
          // chain level above us. The tradeoff: a slightly fragmented delta
          // history is cheaper than buffering every stream for rewind.
          return slot.client.streamMessage({ ...params, model: slot.modelId }, onChunk);
        }
        return slot.client.createMessage({ ...params, model: slot.modelId });
      });
    },
  };
}
