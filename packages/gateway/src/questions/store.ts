import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db/index.js";
import type { AskInput, QuestionRecord } from "@squad/protocol";

interface QuestionRow {
  id: string;
  session_id: string;
  asked_by: string;
  input_json: string;
  answers_json: string | null;
  annotations_json: string | null;
  status: QuestionRecord["status"];
  asked_at: string;
  answered_at: string | null;
  timed_out_at: string | null;
}

function rowToRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    askedBy: row.asked_by,
    input: JSON.parse(row.input_json) as AskInput,
    answers: row.answers_json ? JSON.parse(row.answers_json) : null,
    ...(row.annotations_json
      ? { annotations: JSON.parse(row.annotations_json) }
      : {}),
    status: row.status,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
    timedOutAt: row.timed_out_at,
  };
}

interface Pending {
  resolve: (record: QuestionRecord) => void;
  timer: NodeJS.Timeout | null;
}

export interface QuestionStoreEvents {
  onAsked(q: QuestionRecord): void;
  onAnswered(q: QuestionRecord): void;
  onCancelled(q: QuestionRecord): void;
  onTimedOut(q: QuestionRecord): void;
}

export class QuestionStore {
  private readonly pending: Map<string, Pending> = new Map();

  constructor(
    private readonly db: DatabaseHandle,
    private readonly events: QuestionStoreEvents,
    private readonly defaultTimeoutSeconds: number,
  ) {}

  /**
   * Create a question and return a promise that resolves when a client
   * answers, cancels, or the timeout fires. The final status is always one
   * of: "answered", "cancelled", "timed_out".
   */
  ask(input: {
    sessionId: string;
    askedBy: string;
    input: AskInput;
  }): { id: string; done: Promise<QuestionRecord> } {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO questions (id, session_id, asked_by, input_json, status, asked_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, input.sessionId, input.askedBy, JSON.stringify(input.input), now);
    const record = this.get(id);
    this.events.onAsked(record);

    const timeoutSeconds = input.input.timeoutSeconds ?? this.defaultTimeoutSeconds;
    const done = new Promise<QuestionRecord>((resolve) => {
      const timer = setTimeout(() => {
        this.timeOut(id);
      }, timeoutSeconds * 1000);
      this.pending.set(id, { resolve, timer });
    });

    return { id, done };
  }

  answer(
    sessionId: string,
    questionId: string,
    answers: Record<string, string>,
    annotations?: Record<string, { preview?: string; notes?: string }>,
  ): QuestionRecord {
    const existing = this.get(questionId);
    if (existing.sessionId !== sessionId) {
      throw new Error(`question ${questionId} belongs to a different session`);
    }
    if (existing.status !== "pending") return existing;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE questions SET status = 'answered', answers_json = ?, annotations_json = ?,
           answered_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(answers),
        annotations ? JSON.stringify(annotations) : null,
        now,
        questionId,
      );
    const record = this.get(questionId);
    this.resolvePending(questionId, record);
    this.events.onAnswered(record);
    return record;
  }

  cancel(sessionId: string, questionId: string, _reason?: string): QuestionRecord {
    const existing = this.get(questionId);
    if (existing.sessionId !== sessionId) {
      throw new Error(`question ${questionId} belongs to a different session`);
    }
    if (existing.status !== "pending") return existing;
    this.db
      .prepare(`UPDATE questions SET status = 'cancelled' WHERE id = ?`)
      .run(questionId);
    const record = this.get(questionId);
    this.resolvePending(questionId, record);
    this.events.onCancelled(record);
    return record;
  }

  private timeOut(questionId: string): void {
    const existing = this.tryGet(questionId);
    if (!existing || existing.status !== "pending") return;
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE questions SET status = 'timed_out', timed_out_at = ? WHERE id = ?`)
      .run(now, questionId);
    const record = this.get(questionId);
    this.resolvePending(questionId, record);
    this.events.onTimedOut(record);
  }

  list(opts: { sessionId?: string; status?: QuestionRecord["status"][] }): QuestionRecord[] {
    let sql = "SELECT * FROM questions WHERE 1 = 1";
    const args: unknown[] = [];
    if (opts.sessionId) {
      sql += " AND session_id = ?";
      args.push(opts.sessionId);
    }
    if (opts.status && opts.status.length > 0) {
      sql += ` AND status IN (${opts.status.map(() => "?").join(",")})`;
      args.push(...opts.status);
    }
    sql += " ORDER BY asked_at ASC";
    const rows = this.db.prepare(sql).all(...args) as QuestionRow[];
    return rows.map(rowToRecord);
  }

  history(sessionId: string, limit: number): QuestionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM questions WHERE session_id = ? ORDER BY asked_at DESC LIMIT ?")
      .all(sessionId, limit) as QuestionRow[];
    return rows.reverse().map(rowToRecord);
  }

  get(id: string): QuestionRecord {
    const record = this.tryGet(id);
    if (!record) throw new Error(`question ${id} not found`);
    return record;
  }

  tryGet(id: string): QuestionRecord | null {
    const row = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as
      | QuestionRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  private resolvePending(questionId: string, record: QuestionRecord): void {
    const pending = this.pending.get(questionId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(questionId);
    pending.resolve(record);
  }
}
