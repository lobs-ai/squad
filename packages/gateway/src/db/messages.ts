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
}
