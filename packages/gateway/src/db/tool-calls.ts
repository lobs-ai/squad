import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./index.js";

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  runId: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  status: "pending" | "approved" | "denied" | "completed" | "failed";
  createdAt: string;
  /**
   * The LLM-side tool_use block id this row was created for (e.g.
   * `toolu_01ABC...` from Anthropic, `tool_1` from claude-cli). Lets the
   * dashboard dedup tool_calls fetched on refresh against tool_use blocks
   * already rendered from persisted assistant messages. Optional because
   * legacy rows from before migration 13 have no value.
   */
  llmToolUseId?: string;
}

interface ToolCallRow {
  id: string;
  session_id: string;
  run_id: string;
  name: string;
  input_json: string;
  result_json: string | null;
  is_error: number;
  status: ToolCallRecord["status"];
  created_at: string;
  llm_tool_use_id: string | null;
}

function rowToRecord(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    name: row.name,
    input: JSON.parse(row.input_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    isError: row.is_error === 1,
    status: row.status,
    createdAt: row.created_at,
    ...(row.llm_tool_use_id ? { llmToolUseId: row.llm_tool_use_id } : {}),
  };
}

export class ToolCallStore {
  constructor(private readonly db: DatabaseHandle) {}

  begin(input: {
    sessionId: string;
    runId: string;
    name: string;
    input: unknown;
    llmToolUseId?: string;
  }): ToolCallRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, session_id, run_id, name, input_json, is_error, status, created_at, llm_tool_use_id)
         VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.runId,
        input.name,
        JSON.stringify(input.input),
        now,
        input.llmToolUseId ?? null,
      );
    return this.get(id);
  }

  complete(id: string, result: unknown, isError: boolean): ToolCallRecord {
    this.db
      .prepare(
        `UPDATE tool_calls SET result_json = ?, is_error = ?, status = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result), isError ? 1 : 0, isError ? "failed" : "completed", id);
    return this.get(id);
  }

  get(id: string): ToolCallRecord {
    const row = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as
      | ToolCallRow
      | undefined;
    if (!row) throw new Error(`tool call ${id} not found`);
    return rowToRecord(row);
  }

  /**
   * Returns every persisted tool call for a session, oldest first, capped
   * at `limit` (default 500). Used by `chat.tool_calls` so the dashboard
   * can hydrate its in-memory `liveTools` on refresh — without this,
   * claude-cli's tool activity (which never lands in any message as a
   * `tool_use` block) silently disappears the moment the page reloads.
   */
  listForSession(sessionId: string, limit = 500): ToolCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_calls WHERE session_id = ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as ToolCallRow[];
    return rows.map(rowToRecord);
  }

  countForSession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  countDistinctRunsForSession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT run_id) AS n FROM tool_calls WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }
}
