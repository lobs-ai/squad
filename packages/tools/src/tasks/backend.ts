/**
 * TaskBackend — minimal interface the tasks tools talk to.
 *
 * The gateway implements this in terms of its TaskStore; other runtimes
 * (e.g. the CLI for tests) can stub it. Tools never import from the
 * gateway directly.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
  id: string;
  taskListId: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner: string | null;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBackend {
  create(input: {
    sessionId: string;
    subject: string;
    description: string;
    activeForm?: string;
    owner?: string;
    blockedBy?: string[];
    blocks?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task>;

  update(input: {
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
  }): Promise<Task>;

  get(sessionId: string, taskId: string): Promise<Task>;

  list(
    sessionId: string,
    opts: { includeDeleted?: boolean; status?: TaskStatus[] },
  ): Promise<Task[]>;
}
