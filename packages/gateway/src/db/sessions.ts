import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./index.js";
import type { SessionRecord, SessionStatus, DeliveryMode } from "@squad/protocol";
import { logger as rootLogger } from "../logger.js";

const log = rootLogger.child({ component: "db.sessions" });

interface SessionRow {
  id: string;
  parent_session_id: string | null;
  subagent_def_id: string | null;
  title: string | null;
  platform: string | null;
  remote_id: string | null;
  model: string;
  fallbacks_json: string;
  title_model: string | null;
  status: SessionStatus;
  delivery_mode: DeliveryMode;
  tokens_in: number;
  tokens_out: number;
  compact_at_start: number;
  created_at: string;
  updated_at: string;
}

export type IngestStatus = "idle" | "queued" | "in_progress" | "failed";

export interface SessionIngestState {
  watermarkMessageId: string | null;
  status: IngestStatus;
  attempts: number;
  lastError: string | null;
  chunksProcessed: number;
  lastRunAt: string | null;
  ingestable: boolean;
  updatedAt: string;
}

export interface SessionIdleCandidate {
  sessionId: string;
  watermarkMessageId: string | null;
  updatedAt: string;
}

interface SessionIngestRow {
  ingest_watermark_message_id: string | null;
  ingest_status: IngestStatus;
  ingest_attempts: number;
  ingest_last_error: string | null;
  ingest_chunks_processed: number;
  ingest_last_run_at: string | null;
  ingestable: number;
  updated_at: string;
}

function rowToRecord(row: SessionRow): SessionRecord {
  let fallbacks: string[] = [];
  try {
    const parsed = JSON.parse(row.fallbacks_json);
    if (Array.isArray(parsed)) {
      fallbacks = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch (err) {
    log.warn(
      { err, sessionId: row.id, raw: row.fallbacks_json?.slice(0, 80) },
      "session row has corrupt fallbacks_json — using empty fallback chain",
    );
  }
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    subagentDefId: row.subagent_def_id,
    title: row.title,
    platform: row.platform,
    remoteId: row.remote_id,
    model: row.model,
    fallbacks,
    titleModel: row.title_model,
    status: row.status,
    deliveryMode: row.delivery_mode,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSessionInput {
  title?: string;
  model: string;
  /** Ordered fallback models for this session's sticky chain. Defaults to []. */
  fallbacks?: string[];
  platform?: string;
  remoteId?: string;
  parentSessionId?: string;
  subagentDefId?: string;
  deliveryMode?: DeliveryMode;
}

export type SessionChangeKind = "created" | "updated";

export class SessionStore {
  private readonly db: DatabaseHandle;
  /**
   * Per-session set of tool group names the agent has unlocked via
   * `describe_tool_group`. In-memory only — a gateway restart resets the
   * set, which simply forces the agent to re-describe (cheap; one tool call).
   */
  private readonly unlockedGroups = new Map<string, Set<string>>();

  /**
   * Subscribers fired after every persisted change. The gateway hooks the
   * broadcast bus in here so dashboards/CLI clients see new and modified
   * sessions live, without having to poll `session.list`.
   *
   * Update events fire after token-counter mutations too — they're cheap
   * enough relative to network roundtrip that subscribers can decide whether
   * to debounce on their end.
   */
  private readonly changeListeners = new Set<
    (kind: SessionChangeKind, session: SessionRecord) => void
  >();

  constructor(
    db: DatabaseHandle,
    private readonly defaults: { deliveryMode: DeliveryMode } = { deliveryMode: "interrupt" },
  ) {
    this.db = db;
  }

  onChange(listener: (kind: SessionChangeKind, session: SessionRecord) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emit(kind: SessionChangeKind, session: SessionRecord): void {
    for (const l of this.changeListeners) {
      try {
        l(kind, session);
      } catch (err) {
        log.error(
          { err, kind, sessionId: session.id },
          "session change listener threw — continuing (persistence already committed)",
        );
      }
    }
  }

  /** Mark a tool group as unlocked for the given session. Idempotent. */
  unlockGroup(sessionId: string, groupName: string): void {
    let set = this.unlockedGroups.get(sessionId);
    if (!set) {
      set = new Set();
      this.unlockedGroups.set(sessionId, set);
    }
    set.add(groupName);
  }

  /** Names of tool groups currently unlocked for the session (empty for none). */
  getUnlockedGroups(sessionId: string): readonly string[] {
    const set = this.unlockedGroups.get(sessionId);
    return set ? [...set] : [];
  }

  /** Forget any unlock state for this session. Called on session removal. */
  clearUnlockedGroups(sessionId: string): void {
    this.unlockedGroups.delete(sessionId);
  }

  create(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const deliveryMode = input.deliveryMode ?? this.defaults.deliveryMode;
    const fallbacksJson = JSON.stringify(input.fallbacks ?? []);
    this.db
      .prepare(
        `INSERT INTO sessions (id, parent_session_id, subagent_def_id, title, platform, remote_id,
            model, fallbacks_json, status, delivery_mode, tokens_in, tokens_out, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, 0, 0, ?, ?)`,
      )
      .run(
        id,
        input.parentSessionId ?? null,
        input.subagentDefId ?? null,
        input.title ?? null,
        input.platform ?? null,
        input.remoteId ?? null,
        input.model,
        fallbacksJson,
        deliveryMode,
        now,
        now,
      );
    const record = this.get(id);
    this.emit("created", record);
    return record;
  }

  setDeliveryMode(id: string, mode: DeliveryMode): void {
    this.db
      .prepare("UPDATE sessions SET delivery_mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, new Date().toISOString(), id);
    this.emit("updated", this.get(id));
  }

  get(id: string): SessionRecord {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    if (!row) throw new Error(`session ${id} not found`);
    return rowToRecord(row);
  }

  tryGet(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByRemote(platform: string, remoteId: string): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE platform = ? AND remote_id = ?")
      .get(platform, remoteId) as SessionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(opts: {
    parentSessionId?: string | null;
    limit: number;
  }): SessionRecord[] {
    let rows: SessionRow[];
    if (opts.parentSessionId === null) {
      rows = this.db
        .prepare(
          "SELECT * FROM sessions WHERE parent_session_id IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .all(opts.limit) as SessionRow[];
    } else if (opts.parentSessionId) {
      rows = this.db
        .prepare(
          "SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(opts.parentSessionId, opts.limit) as SessionRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
        .all(opts.limit) as SessionRow[];
    }
    return rows.map(rowToRecord);
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    this.emit("updated", this.get(id));
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), id);
    this.emit("updated", this.get(id));
  }

  setModel(id: string, model: string, fallbacks?: string[]): void {
    if (fallbacks !== undefined) {
      this.db
        .prepare(
          "UPDATE sessions SET model = ?, fallbacks_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(model, JSON.stringify(fallbacks), new Date().toISOString(), id);
    } else {
      this.db
        .prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
        .run(model, new Date().toISOString(), id);
    }
    this.emit("updated", this.get(id));
  }

  setTitleModel(id: string, titleModel: string | null): void {
    this.db
      .prepare("UPDATE sessions SET title_model = ?, updated_at = ? WHERE id = ?")
      .run(titleModel, new Date().toISOString(), id);
    this.emit("updated", this.get(id));
  }

  /**
   * Arm the next run to compact history before the LLM call. The runner
   * checks this flag on session load and clears it via {@link clearCompactAtStart}
   * once the compaction has happened.
   */
  setCompactAtStart(id: string, armed: boolean): void {
    this.db
      .prepare("UPDATE sessions SET compact_at_start = ?, updated_at = ? WHERE id = ?")
      .run(armed ? 1 : 0, new Date().toISOString(), id);
  }

  clearCompactAtStart(id: string): void {
    this.setCompactAtStart(id, false);
  }

  getCompactAtStart(id: string): boolean {
    const row = this.db
      .prepare("SELECT compact_at_start FROM sessions WHERE id = ?")
      .get(id) as { compact_at_start: number } | undefined;
    return !!row?.compact_at_start;
  }

  addTokens(id: string, tokensIn: number, tokensOut: number): void {
    this.db
      .prepare(
        "UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? WHERE id = ?",
      )
      .run(tokensIn, tokensOut, new Date().toISOString(), id);
    this.emit("updated", this.get(id));
  }

  // ─── ingestion state ────────────────────────────────────────────────────
  // Memory ingestion runs idle-driven and incremental. The watermark records
  // the last message already fed to MemCore; the status field gates the
  // sweeper / queue worker. See packages/gateway/src/memory/session-ingest.ts.

  setIngestable(id: string, ingestable: boolean): void {
    this.db
      .prepare("UPDATE sessions SET ingestable = ?, updated_at = ? WHERE id = ?")
      .run(ingestable ? 1 : 0, new Date().toISOString(), id);
  }

  setIngestStatus(
    id: string,
    status: IngestStatus,
    opts: { attempts?: number; lastError?: string | null } = {},
  ): void {
    const stmt =
      opts.attempts !== undefined && opts.lastError !== undefined
        ? "UPDATE sessions SET ingest_status = ?, ingest_attempts = ?, ingest_last_error = ?, updated_at = ? WHERE id = ?"
        : "UPDATE sessions SET ingest_status = ?, updated_at = ? WHERE id = ?";
    if (opts.attempts !== undefined && opts.lastError !== undefined) {
      this.db
        .prepare(stmt)
        .run(status, opts.attempts, opts.lastError, new Date().toISOString(), id);
    } else {
      this.db.prepare(stmt).run(status, new Date().toISOString(), id);
    }
  }

  recordIngestSuccess(
    id: string,
    watermarkMessageId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET ingest_status = 'idle',
                ingest_watermark_message_id = ?,
                ingest_attempts = 0,
                ingest_last_error = NULL,
                ingest_chunks_processed = ingest_chunks_processed + 1,
                ingest_last_run_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(watermarkMessageId, new Date().toISOString(), new Date().toISOString(), id);
  }

  getIngestState(id: string): SessionIngestState {
    const row = this.db
      .prepare(
        `SELECT ingest_watermark_message_id, ingest_status, ingest_attempts,
                ingest_last_error, ingest_chunks_processed, ingest_last_run_at,
                ingestable, updated_at
           FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionIngestRow | undefined;
    if (!row) throw new Error(`session ${id} not found`);
    return {
      watermarkMessageId: row.ingest_watermark_message_id,
      status: row.ingest_status,
      attempts: row.ingest_attempts,
      lastError: row.ingest_last_error,
      chunksProcessed: row.ingest_chunks_processed,
      lastRunAt: row.ingest_last_run_at,
      ingestable: !!row.ingestable,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Sessions the idle sweeper should consider: ingestable, idle (status not
   * `queued`/`in_progress`), updated more than `idleSeconds` ago. Failed
   * sessions are excluded — they're surfaced via logs instead of retried in
   * the hot loop.
   */
  listIdleForIngest(opts: { idleSeconds: number; limit: number }): SessionIdleCandidate[] {
    const cutoff = new Date(Date.now() - opts.idleSeconds * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, ingest_watermark_message_id, updated_at
           FROM sessions
          WHERE ingestable = 1
            AND ingest_status = 'idle'
            AND updated_at < ?
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
      .all(cutoff, opts.limit) as Array<{
      id: string;
      ingest_watermark_message_id: string | null;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.id,
      watermarkMessageId: r.ingest_watermark_message_id,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Boot-time recovery. Anything stuck in `in_progress` or `queued` from a
   * previous process gets reset to `idle` so the sweeper picks it up again
   * on its own schedule. We don't auto-retry `failed` — those need either an
   * admin re-trigger or a code fix.
   */
  resetInFlightIngest(): number {
    const result = this.db
      .prepare(
        `UPDATE sessions
            SET ingest_status = 'idle',
                updated_at = ?
          WHERE ingest_status IN ('queued', 'in_progress')`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }

  /**
   * Boot-time recovery for chat runs. Returns the ids of every session
   * left in `running` from a previous process — these are the sessions
   * whose turn the gateway was mid-flight on when it crashed/restarted.
   * The caller (run recovery in index.ts) repairs the message tail and
   * re-fires a turn, then sets each back to `idle`.
   */
  listRunningSessionIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM sessions WHERE status = 'running'`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * Walk up parent_session_id until we hit NULL. Used to resolve the
   * task_list_id for a session tree.
   */
  rootId(id: string): string {
    let current = id;
    while (true) {
      const row = this.db
        .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
        .get(current) as { parent_session_id: string | null } | undefined;
      if (!row) throw new Error(`session ${current} not found`);
      if (row.parent_session_id === null) return current;
      current = row.parent_session_id;
    }
  }
}
