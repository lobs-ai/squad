/**
 * Keep-warm pool — a latency cache over resume-per-turn, never the source of
 * truth. A parked session skips the next turn's cold start (transcript re-read
 * + MCP re-init, the ~10K-token catalog tax). If it dies, the next turn just
 * resumes cold from the harness transcript.
 *
 * A warm session is reusable only when the parts of its start spec that would
 * force a fresh process are unchanged — notably the appended system prompt
 * (eager memory / core files) and the model/auth/toolset. That is exactly the
 * "a held process can't take a new system prompt mid-session" caveat, enforced
 * by `specKey`.
 */

import type { ApprovalHook, HarnessSession, HarnessStartSpec } from "./types.js";

/**
 * Identity of the spec parts that, if changed, require re-initializing the
 * harness process. Resume target is intentionally excluded — a warm session
 * already *is* that conversation.
 */
function specKey(spec: HarnessStartSpec): string {
  return JSON.stringify([
    spec.model,
    spec.auth.mode,
    spec.auth.baseUrl ?? "",
    spec.auth.provider ?? "",
    spec.appendSystemPrompt,
    [...spec.allowedNativeTools].sort(),
    spec.squadTools.tools.map((t) => t.name).sort(),
    spec.cwd,
  ]);
}

export interface WarmPoolOptions {
  /** Opens (or resumes) a fresh harness session. */
  open: (spec: HarnessStartSpec, approval: ApprovalHook) => Promise<HarnessSession>;
  /** How long an idle session stays warm, ms. Default 180_000 (3 min). 0 disables warming. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface WarmEntry {
  session: HarnessSession;
  specKey: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class WarmPool {
  private readonly entries = new Map<string, WarmEntry>();
  private readonly open: WarmPoolOptions["open"];
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: WarmPoolOptions) {
    this.open = opts.open;
    this.ttlMs = opts.ttlMs ?? 180_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Get a session for this turn: reuse a compatible warm one, else open fresh.
   * The returned session is detached from the pool for the turn's duration (so
   * a sweep can't close it mid-turn); call `release` when the turn ends.
   */
  async acquire(spec: HarnessStartSpec, approval: ApprovalHook): Promise<HarnessSession> {
    const warm = this.entries.get(spec.sessionId);
    if (warm) {
      this.detach(spec.sessionId);
      if (warm.specKey === specKey(spec)) return warm.session;
      // Prompt / model / toolset changed — the warm process is stale.
      await safeClose(warm.session);
    }
    return this.open(spec, approval);
  }

  /** Park a session as warm for `ttlMs`. With ttl<=0, closes it immediately. */
  release(session: HarnessSession, spec: HarnessStartSpec): void {
    if (this.ttlMs <= 0) {
      void safeClose(session);
      return;
    }
    const prior = this.entries.get(spec.sessionId);
    if (prior) {
      this.detach(spec.sessionId);
      void safeClose(prior.session);
    }
    const timer = setTimeout(() => void this.evict(spec.sessionId), this.ttlMs);
    timer.unref?.();
    this.entries.set(spec.sessionId, {
      session,
      specKey: specKey(spec),
      expiresAt: this.now() + this.ttlMs,
      timer,
    });
  }

  /** Close and forget a warm session. */
  async evict(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.detach(sessionId);
    await safeClose(entry.session);
  }

  /**
   * Close every warm session. Call from the gateway shutdown path BEFORE
   * http.close so a parked process can't hold the shutdown open (the
   * restart-hang vector).
   */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      all.map((e) => {
        if (e.timer) clearTimeout(e.timer);
        return safeClose(e.session);
      }),
    );
  }

  size(): number {
    return this.entries.size;
  }

  private detach(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(sessionId);
  }
}

async function safeClose(session: HarnessSession): Promise<void> {
  try {
    await session.close();
  } catch {
    /* best-effort — teardown failures must not propagate */
  }
}
