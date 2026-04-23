import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./index.js";
import type { SessionRecord, SessionStatus, DeliveryMode } from "@squad/protocol";

interface SessionRow {
  id: string;
  parent_session_id: string | null;
  subagent_def_id: string | null;
  title: string | null;
  platform: string | null;
  remote_id: string | null;
  model: string;
  status: SessionStatus;
  delivery_mode: DeliveryMode;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    subagentDefId: row.subagent_def_id,
    title: row.title,
    platform: row.platform,
    remoteId: row.remote_id,
    model: row.model,
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
  platform?: string;
  remoteId?: string;
  parentSessionId?: string;
  subagentDefId?: string;
  deliveryMode?: DeliveryMode;
}

export class SessionStore {
  private readonly db: DatabaseHandle;
  constructor(
    db: DatabaseHandle,
    private readonly defaults: { deliveryMode: DeliveryMode } = { deliveryMode: "interrupt" },
  ) {
    this.db = db;
  }

  create(input: CreateSessionInput): SessionRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const deliveryMode = input.deliveryMode ?? this.defaults.deliveryMode;
    this.db
      .prepare(
        `INSERT INTO sessions (id, parent_session_id, subagent_def_id, title, platform, remote_id,
            model, status, delivery_mode, tokens_in, tokens_out, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, 0, 0, ?, ?)`,
      )
      .run(
        id,
        input.parentSessionId ?? null,
        input.subagentDefId ?? null,
        input.title ?? null,
        input.platform ?? null,
        input.remoteId ?? null,
        input.model,
        deliveryMode,
        now,
        now,
      );
    return this.get(id);
  }

  setDeliveryMode(id: string, mode: DeliveryMode): void {
    this.db
      .prepare("UPDATE sessions SET delivery_mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, new Date().toISOString(), id);
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
  }

  addTokens(id: string, tokensIn: number, tokensOut: number): void {
    this.db
      .prepare(
        "UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? WHERE id = ?",
      )
      .run(tokensIn, tokensOut, new Date().toISOString(), id);
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
