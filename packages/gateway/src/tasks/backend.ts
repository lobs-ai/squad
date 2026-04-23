import type { TaskBackend, TaskBackendTask } from "@squad/tools";
import type { TaskStore } from "./store.js";

/**
 * Bridge the TaskStore (SQLite-backed) into the shape the task tools expect.
 * The shape is already identical — this adapter exists so the tools package
 * can stay ignorant of the gateway's store implementation.
 */
export function taskBackendFor(store: TaskStore): TaskBackend {
  return {
    create: async (input) => store.create(input) as Promise<TaskBackendTask>,
    update: async (input) => store.update(input) as Promise<TaskBackendTask>,
    get: async (sessionId, taskId) => store.get(sessionId, taskId) as TaskBackendTask,
    list: async (sessionId, opts) =>
      store.list(sessionId, {
        includeDeleted: opts.includeDeleted ?? false,
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      }) as TaskBackendTask[],
  };
}
