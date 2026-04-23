import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db/index.js";
import type { SessionStore } from "../db/sessions.js";
import type { Task, TaskStatus } from "@squad/protocol";
import { KeyedMutex } from "./mutex.js";

interface TaskRow {
  id: string;
  task_list_id: string;
  subject: string;
  description: string;
  active_form: string | null;
  owner: string | null;
  status: TaskStatus;
  blocks_json: string;
  blocked_by_json: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    taskListId: row.task_list_id,
    subject: row.subject,
    description: row.description,
    owner: row.owner,
    status: row.status,
    blocks: JSON.parse(row.blocks_json),
    blockedBy: JSON.parse(row.blocked_by_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.active_form !== null) task.activeForm = row.active_form;
  if (row.metadata_json) task.metadata = JSON.parse(row.metadata_json);
  return task;
}

export interface TaskStoreEvents {
  onCreated(task: Task): void;
  onUpdated(task: Task): void;
  onDeleted(task: Task): void;
}

export interface CreateInput {
  sessionId: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
  blocks?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateInput {
  sessionId: string;
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string | null;
  status?: TaskStatus;
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export class TaskStore {
  private readonly mutex: KeyedMutex<string> = new KeyedMutex();

  constructor(
    private readonly db: DatabaseHandle,
    private readonly sessions: SessionStore,
    private readonly events: TaskStoreEvents,
  ) {}

  /** Resolve a sessionId to its session-tree's root id. */
  resolveListId(sessionId: string): string {
    return this.sessions.rootId(sessionId);
  }

  async create(input: CreateInput): Promise<Task> {
    const listId = this.resolveListId(input.sessionId);
    return this.mutex.run(listId, () => {
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO tasks (id, task_list_id, subject, description, active_form, owner,
              status, blocks_json, blocked_by_json, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          listId,
          input.subject,
          input.description,
          input.activeForm ?? null,
          input.owner ?? null,
          JSON.stringify(input.blocks ?? []),
          JSON.stringify(input.blockedBy ?? []),
          input.metadata ? JSON.stringify(input.metadata) : null,
          now,
          now,
        );
      const task = this.getById(id);
      this.events.onCreated(task);
      return Promise.resolve(task);
    });
  }

  async update(input: UpdateInput): Promise<Task> {
    const listId = this.resolveListId(input.sessionId);
    return this.mutex.run(listId, () => {
      const existing = this.getById(input.taskId);
      if (existing.taskListId !== listId) {
        throw new Error(`task ${input.taskId} belongs to a different session tree`);
      }

      const blocks = mergeEdges(existing.blocks, input.addBlocks, input.removeBlocks);
      const blockedBy = mergeEdges(
        existing.blockedBy,
        input.addBlockedBy,
        input.removeBlockedBy,
      );
      const subject = input.subject ?? existing.subject;
      const description = input.description ?? existing.description;
      const activeForm =
        input.activeForm !== undefined ? input.activeForm : existing.activeForm ?? null;
      const owner = input.owner === undefined ? existing.owner : input.owner;
      const status = input.status ?? existing.status;
      const metadata = input.metadata
        ? { ...(existing.metadata ?? {}), ...input.metadata }
        : existing.metadata;

      this.db
        .prepare(
          `UPDATE tasks SET subject = ?, description = ?, active_form = ?, owner = ?,
              status = ?, blocks_json = ?, blocked_by_json = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          subject,
          description,
          activeForm,
          owner,
          status,
          JSON.stringify(blocks),
          JSON.stringify(blockedBy),
          metadata ? JSON.stringify(metadata) : null,
          new Date().toISOString(),
          input.taskId,
        );
      const updated = this.getById(input.taskId);
      if (status === "deleted") this.events.onDeleted(updated);
      else this.events.onUpdated(updated);
      return Promise.resolve(updated);
    });
  }

  async softDelete(sessionId: string, taskId: string): Promise<Task> {
    return this.update({ sessionId, taskId, status: "deleted" });
  }

  async claim(sessionId: string, taskId: string, owner: string): Promise<Task> {
    return this.update({ sessionId, taskId, owner, status: "in_progress" });
  }

  get(sessionId: string, taskId: string): Task {
    const listId = this.resolveListId(sessionId);
    const task = this.getById(taskId);
    if (task.taskListId !== listId) {
      throw new Error(`task ${taskId} belongs to a different session tree`);
    }
    return task;
  }

  getById(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    if (!row) throw new Error(`task ${id} not found`);
    return rowToTask(row);
  }

  list(sessionId: string, opts: { includeDeleted: boolean; status?: TaskStatus[] }): Task[] {
    const listId = this.resolveListId(sessionId);
    let sql = "SELECT * FROM tasks WHERE task_list_id = ?";
    const args: unknown[] = [listId];
    if (!opts.includeDeleted) sql += " AND status != 'deleted'";
    if (opts.status && opts.status.length > 0) {
      sql += ` AND status IN (${opts.status.map(() => "?").join(",")})`;
      args.push(...opts.status);
    }
    sql += " ORDER BY created_at ASC";
    const rows = this.db.prepare(sql).all(...args) as TaskRow[];
    return rows.map(rowToTask);
  }
}

function mergeEdges(current: string[], add?: string[], remove?: string[]): string[] {
  let out = current;
  if (add && add.length > 0) out = Array.from(new Set([...out, ...add]));
  if (remove && remove.length > 0) {
    const drop = new Set(remove);
    out = out.filter((id) => !drop.has(id));
  }
  return out;
}
