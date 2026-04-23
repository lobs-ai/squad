// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/session.ts
// Last synced: 2026-04-23

/**
 * Session — shared message history for an agent run.
 *
 * Create a Session before starting an agent to get a live view of the
 * conversation as it progresses. Pass it to `Agent.withSession()` and
 * the loop will read and write through it instead of a private array.
 *
 * The application and the loop share the *same* underlying array, so
 * `session.messages` always reflects the live state — no polling needed.
 *
 * For persistence across requests, implement `SessionStore` and use
 * `Session.fromStore()` to load and `session.flush()` to save.
 *
 * @example In-memory (single request)
 * ```ts
 * const session = new Session();
 * const result = await runtime.agent({ model: "claude-sonnet-4-6" })
 *   .withSession(session)
 *   .run("Summarize the codebase.");
 * console.log(session.messages.length, "messages");
 * ```
 *
 * @example Persistent (across requests)
 * ```ts
 * // Load history from DB, run, then save it back
 * const session = await Session.fromStore("conv_abc", myDbStore);
 * await runtime.agent({ model: "claude-sonnet-4-6" })
 *   .withSession(session)
 *   .run("Continue from where you left off.");
 * await session.flush(); // persist the updated history
 * ```
 */

import type { LLMMessage } from "@squad/llm";

// ── SessionStore interface ────────────────────────────────────────────────────

/**
 * Interface for persisting session message history.
 *
 * Implement this with your database of choice — Drizzle, Prisma, Redis, etc.
 * The library makes no assumptions about storage format.
 *
 * @example Drizzle + Postgres
 * ```ts
 * class DrizzleSessionStore implements SessionStore {
 *   async load(id: string) {
 *     const rows = await db.select().from(messages)
 *       .where(eq(messages.sessionId, id))
 *       .orderBy(asc(messages.createdAt));
 *     return rows.map(r => ({ role: r.role, content: r.content }));
 *   }
 *   async save(id: string, messages: readonly LLMMessage[]) {
 *     await db.delete(messages).where(eq(messages.sessionId, id));
 *     await db.insert(messages).values(
 *       messages.map(m => ({ sessionId: id, role: m.role, content: m.content }))
 *     );
 *   }
 * }
 * ```
 */
export interface SessionStore {
  /**
   * Load message history for a session.
   * Return an empty array if the session doesn't exist yet.
   */
  load(sessionId: string): Promise<LLMMessage[]>;
  /**
   * Persist the current message history.
   * Called by `session.flush()` — implement as an upsert.
   */
  save(sessionId: string, messages: readonly LLMMessage[]): Promise<void>;
}

// ── Session ───────────────────────────────────────────────────────────────────

export class Session {
  private readonly _messages: LLMMessage[];
  private readonly _sessionId: string | null;
  private readonly _store: SessionStore | null;

  constructor(
    initialMessages: LLMMessage[] = [],
    sessionId: string | null = null,
    store: SessionStore | null = null,
  ) {
    this._messages = initialMessages;
    this._sessionId = sessionId;
    this._store = store;
  }

  // ── Static factories ──────────────────────────────────────────────────────

  /**
   * Load a session's message history from a `SessionStore`.
   *
   * Returns a `Session` instance pre-seeded with the stored messages.
   * Call `session.flush()` after the run to persist the updated history.
   *
   * @example
   * ```ts
   * const session = await Session.fromStore("conv_abc", store);
   * await runtime.agent({ model: "claude-sonnet-4-6" })
   *   .withSession(session)
   *   .run("What did we discuss last time?");
   * await session.flush();
   * ```
   */
  static async fromStore(
    sessionId: string,
    store: SessionStore,
  ): Promise<Session> {
    const messages = await store.load(sessionId);
    return new Session(messages, sessionId, store);
  }

  // ── Application API ───────────────────────────────────────────────────────

  /** The session ID, or null for in-memory sessions. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Live read-only view of the current message history. */
  get messages(): readonly LLMMessage[] {
    return this._messages;
  }

  /**
   * Persist the current message history to the session store.
   *
   * No-op when no store was provided (in-memory sessions).
   *
   * @throws When the store's `save()` throws.
   */
  async flush(): Promise<void> {
    if (!this._store || !this._sessionId) return;
    await this._store.save(this._sessionId, this._messages);
  }

  /**
   * Replace the message history in-place.
   *
   * Safe to call while a run is active — the loop sees the new messages
   * on its next turn. You are responsible for keeping tool_use ↔ tool_result
   * pairing intact.
   */
  seed(messages: LLMMessage[]): this {
    this._messages.length = 0;
    this._messages.push(...messages);
    return this;
  }

  /**
   * Return an independent copy of this session (no store attached).
   * Useful for branching: run a speculative path without affecting the original.
   */
  fork(): Session {
    return new Session([...this._messages]);
  }

  // ── Internal: used by the agent loop only ────────────────────────────────

  /**
   * @internal Direct mutable reference — only the loop should use this.
   *
   * Returns the same array the session wraps. All push/splice mutations
   * made by the loop are automatically visible through `session.messages`.
   */
  _ref(): LLMMessage[] {
    return this._messages;
  }
}
