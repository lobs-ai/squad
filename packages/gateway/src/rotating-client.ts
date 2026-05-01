import type { CreateMessageParams, LLMClient, LLMResponse } from "@squad/llm";
import type { Logger } from "./logger.js";
import type { ResolvedKey, ResolvedKeyPools } from "./llm-config.js";

/**
 * Build per-provider, per-key clients for a key pool.
 *
 * Caller passes a `buildClient(provider, key)` factory that knows how to wire
 * a single LLMClient bound to one specific key — usually a thin wrapper around
 * the LLM package's `createClient` with the matching `keys[provider]` entry.
 *
 * Each provider's pool yields `n` clients, one per key. The RotatingLLMClient
 * then round-robins across them and excludes a client for a configurable
 * backoff window when its provider returns 429 / 5xx / network errors.
 */
export type ClientFactory = (provider: string, key: ResolvedKey) => LLMClient;

export interface RotatingLLMClientOptions {
  /** Backoff window applied after a rotation-eligible failure. Default 60s. */
  backoffMs?: number;
  /** Provider name → resolved key pool. */
  pools: ResolvedKeyPools;
  /** Build a single-key client for the given (provider, key). */
  buildClient: ClientFactory;
  logger: Logger;
  /**
   * Determines which provider every model belongs to. The gateway hands a
   * `parseModelString`-like fn so we don't recreate provider inference here.
   */
  inferProvider: (model: string) => string | null;
  /**
   * Fallback for providers without a key pool — we delegate the entire call
   * to this client. Lets the gateway compose rotation around an existing
   * model-chain client without losing its fallback behavior.
   */
  delegate?: LLMClient;
}

interface PoolEntry {
  client: LLMClient;
  key: ResolvedKey;
  /** Epoch ms at which the entry leaves backoff. 0 = available now. */
  cooldownUntil: number;
  failures: number;
}

const DEFAULT_BACKOFF_MS = 60_000;

/**
 * LLMClient that wraps a key pool per provider and rotates round-robin on
 * every call. A 429 or 5xx response excludes the responsible key for
 * `backoffMs`; the next call picks the next available key. When every key
 * is in cooldown the request still goes through the least-recently-failed
 * one rather than failing fast — caller can layer their own circuit breaker
 * on top.
 *
 * Stateless on the LLM payload side: we delegate every call straight to the
 * picked client. The wrapper's only state is the pool's cursor + cooldowns.
 */
export class RotatingLLMClient implements LLMClient {
  private readonly pools = new Map<string, PoolEntry[]>();
  private readonly cursors = new Map<string, number>();
  private readonly backoffMs: number;
  private readonly logger: Logger;
  private readonly inferProvider: (model: string) => string | null;
  private readonly delegate: LLMClient | undefined;

  constructor(opts: RotatingLLMClientOptions) {
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.logger = opts.logger;
    this.inferProvider = opts.inferProvider;
    this.delegate = opts.delegate;
    for (const [provider, keys] of Object.entries(opts.pools)) {
      if (!keys || keys.length === 0) continue;
      const entries: PoolEntry[] = keys.map((k) => ({
        client: opts.buildClient(provider, k),
        key: k,
        cooldownUntil: 0,
        failures: 0,
      }));
      this.pools.set(provider, entries);
    }
  }

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    const provider = this.inferProvider(params.model);
    if (provider && this.pools.has(provider)) {
      return this.callWithRotation(provider, (client) => client.createMessage(params));
    }
    if (this.delegate) return this.delegate.createMessage(params);
    if (!provider) throw new Error(`unable to infer provider for model "${params.model}"`);
    throw new Error(`no keys configured for provider "${provider}"`);
  }

  async streamMessage(
    params: CreateMessageParams,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    const provider = this.inferProvider(params.model);
    if (provider && this.pools.has(provider)) {
      return this.callWithRotation(provider, (client) => {
        if (!client.streamMessage) return client.createMessage(params);
        return client.streamMessage(params, onChunk);
      });
    }
    if (this.delegate?.streamMessage) return this.delegate.streamMessage(params, onChunk);
    if (this.delegate) return this.delegate.createMessage(params);
    if (!provider) throw new Error(`unable to infer provider for model "${params.model}"`);
    throw new Error(`no keys configured for provider "${provider}"`);
  }

  /**
   * Pick a key, run the call, mark cooldown on rotation-eligible failures,
   * and retry on the next available key (up to one full pass through the
   * pool). The first pass picks fresh-or-cooled-down keys; the second pass
   * picks any key (even ones still in cooldown) so caller doesn't see a
   * "no keys available" error when they could just go through anyway.
   */
  private async callWithRotation<T>(
    provider: string,
    invoke: (client: LLMClient) => Promise<T>,
  ): Promise<T> {
    const pool = this.pools.get(provider)!;
    const total = pool.length;
    let lastErr: unknown = null;

    // Pass 1: only cooled-down keys.
    for (let attempt = 0; attempt < total; attempt++) {
      const idx = this.advanceCursor(provider, pool);
      const entry = pool[idx]!;
      if (this.inCooldown(entry)) continue;
      try {
        return await invoke(entry.client);
      } catch (err) {
        lastErr = err;
        if (this.isRotationEligible(err)) {
          this.markFailure(provider, entry, err);
          continue;
        }
        throw err;
      }
    }

    // Pass 2: every key, ignoring cooldown — better to retry a degraded key
    // than fail outright when pool's saturated.
    for (let attempt = 0; attempt < total; attempt++) {
      const idx = this.advanceCursor(provider, pool);
      const entry = pool[idx]!;
      try {
        return await invoke(entry.client);
      } catch (err) {
        lastErr = err;
        if (this.isRotationEligible(err)) {
          this.markFailure(provider, entry, err);
          continue;
        }
        throw err;
      }
    }

    throw lastErr ?? new Error(`every key for provider "${provider}" failed`);
  }

  private advanceCursor(provider: string, pool: PoolEntry[]): number {
    const next = ((this.cursors.get(provider) ?? -1) + 1) % pool.length;
    this.cursors.set(provider, next);
    return next;
  }

  private inCooldown(entry: PoolEntry): boolean {
    return entry.cooldownUntil > Date.now();
  }

  private markFailure(provider: string, entry: PoolEntry, err: unknown): void {
    entry.failures++;
    entry.cooldownUntil = Date.now() + this.backoffMs;
    this.logger.warn(
      {
        provider,
        keyLabel: entry.key.label,
        failures: entry.failures,
        backoffMs: this.backoffMs,
        err: err instanceof Error ? err.message : String(err),
      },
      "key rotated out — provider call failed",
    );
  }

  /**
   * Identify errors that should trigger rotation rather than fast-fail.
   * 429 (rate limit) and 5xx (server) are the obvious candidates; we also
   * catch network-y errors (`ECONNRESET`, etc.) and timeouts. 4xx other
   * than 429 indicates a request shape problem — those propagate up.
   */
  private isRotationEligible(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number; code?: string }).status;
    if (status === 429) return true;
    if (status && status >= 500 && status <= 599) return true;
    if (/429|rate[_\s-]?limit|too many requests/i.test(msg)) return true;
    if (/5\d{2}\b|server error|internal error/i.test(msg)) return true;
    if (/ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|timeout/i.test(msg)) return true;
    if ((err as { code?: string }).code &&
        /^E(CONN|TIMEDOUT|FATAL)/i.test((err as { code: string }).code)) {
      return true;
    }
    return false;
  }

  /** Snapshot pool health for diagnostics. */
  status(): Array<{
    provider: string;
    keyLabel: string;
    failures: number;
    inCooldown: boolean;
    cooldownRemainingMs: number;
  }> {
    const now = Date.now();
    const out: Array<{
      provider: string;
      keyLabel: string;
      failures: number;
      inCooldown: boolean;
      cooldownRemainingMs: number;
    }> = [];
    for (const [provider, entries] of this.pools) {
      for (const e of entries) {
        out.push({
          provider,
          keyLabel: e.key.label,
          failures: e.failures,
          inCooldown: e.cooldownUntil > now,
          cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
        });
      }
    }
    return out;
  }
}

/**
 * True iff at least one provider in the resolved pools has 2+ keys. When false,
 * the gateway short-circuits and uses the unwrapped LLM client.
 */
export function shouldRotateKeys(pools: ResolvedKeyPools): boolean {
  for (const keys of Object.values(pools)) {
    if (keys && keys.length >= 2) return true;
  }
  return false;
}
