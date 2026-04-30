import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./index.js";
import type { ContentBlock, MessageRecord } from "@squad/protocol";

interface MessageRow {
  id: string;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content_json: string;
  created_at: string;
}

function rowToRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: JSON.parse(row.content_json) as ContentBlock[],
    createdAt: row.created_at,
  };
}

function extractText(content: ContentBlock[]): string {
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? b.name : ""))
    .filter(Boolean)
    .join("\n");
}

export class MessageStore {
  constructor(private readonly db: DatabaseHandle) {}

  append(input: {
    sessionId: string;
    role: "system" | "user" | "assistant" | "tool";
    content: ContentBlock[];
  }): MessageRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const contentJson = JSON.stringify(input.content);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, role, content_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.sessionId, input.role, contentJson, now);
      const text = extractText(input.content);
      if (text) {
        this.db.prepare("INSERT INTO messages_fts (rowid, text) VALUES ((SELECT rowid FROM messages WHERE id = ?), ?)").run(id, text);
      }
    });
    tx();
    return this.get(id);
  }

  get(id: string): MessageRecord {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | MessageRow
      | undefined;
    if (!row) throw new Error(`message ${id} not found`);
    return rowToRecord(row);
  }

  listForSession(sessionId: string, limit: number, before?: string): MessageRecord[] {
    let rows: MessageRow[];
    if (before) {
      rows = this.db
        .prepare(
          `SELECT * FROM messages WHERE session_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(sessionId, before, limit) as MessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM messages WHERE session_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(sessionId, limit) as MessageRow[];
    }
    // Reverse so callers get chronological order.
    return rows.reverse().map(rowToRecord);
  }

  countForSession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * Cheap token estimate: sum content character length divided by 4. The
   * runner uses the same heuristic for its threshold check (see
   * runner/context-manager.ts). Good enough for /usage and /compress display.
   */
  estimateTokensForSession(sessionId: string): number {
    const rows = this.db
      .prepare("SELECT content_json FROM messages WHERE session_id = ?")
      .all(sessionId) as Array<{ content_json: string }>;
    let chars = 0;
    for (const r of rows) chars += r.content_json.length;
    return Math.ceil(chars / 4);
  }

  /**
   * Run an FTS5 search across `messages_fts`, optionally scoped to a single
   * session. Returns `messageId`, `sessionId`, a snippet (32-token window),
   * the message timestamp, and the BM25 score (lower = better).
   *
   * The query string is passed through `fts5SafeQuery` so user-typed
   * apostrophes/quotes and accidental operators don't blow up the parser.
   */
  search(input: {
    query: string;
    limit: number;
    sessionId?: string;
  }): Array<{
    messageId: string;
    sessionId: string;
    snippet: string;
    ts: string;
    score: number;
  }> {
    const safe = fts5SafeQuery(input.query);
    if (!safe) return [];

    const sql = input.sessionId
      ? `SELECT m.id AS message_id,
                m.session_id AS session_id,
                m.created_at AS created_at,
                snippet(messages_fts, 0, '<<', '>>', '…', 16) AS snippet,
                bm25(messages_fts) AS score
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ? AND m.session_id = ?
          ORDER BY score
          LIMIT ?`
      : `SELECT m.id AS message_id,
                m.session_id AS session_id,
                m.created_at AS created_at,
                snippet(messages_fts, 0, '<<', '>>', '…', 16) AS snippet,
                bm25(messages_fts) AS score
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?
          ORDER BY score
          LIMIT ?`;

    const stmt = this.db.prepare(sql);
    const rows = (
      input.sessionId
        ? stmt.all(safe, input.sessionId, input.limit)
        : stmt.all(safe, input.limit)
    ) as Array<{
      message_id: string;
      session_id: string;
      created_at: string;
      snippet: string;
      score: number;
    }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      sessionId: r.session_id,
      ts: r.created_at,
      snippet: r.snippet,
      score: r.score,
    }));
  }
}

/**
 * FTS5's MATCH operator parses query syntax (NEAR, OR, AND, quoting, …).
 * For an end-user free-text search, we don't want a stray apostrophe or
 * unbalanced quote to throw. Strip operator characters and quote each
 * remaining token, joined with implicit AND ("foo" "bar"). Empty input
 * returns "" so the caller can short-circuit.
 */
export function fts5SafeQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["()*:^]/g, ""))
    .map((t) => t.replace(/^[-+]+|[-+]+$/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}
