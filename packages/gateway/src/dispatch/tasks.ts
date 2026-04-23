import type { Dispatcher } from "./index.js";
import type { TaskStore } from "../tasks/store.js";
import type { Broadcast } from "../broadcast.js";

export function registerTaskMethods(
  dispatcher: Dispatcher,
  store: TaskStore,
  _broadcast: Broadcast,
): void {
  dispatcher.register("tasks.create", async (params) => {
    const task = await store.create({
      sessionId: params.sessionId,
      subject: params.subject,
      description: params.description,
      ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
      ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
      ...(params.blocks !== undefined ? { blocks: params.blocks } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    });
    return { task };
  });

  dispatcher.register("tasks.update", async (params) => {
    const task = await store.update({
      sessionId: params.sessionId,
      taskId: params.taskId,
      ...(params.subject !== undefined ? { subject: params.subject } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
      ...(params.owner !== undefined ? { owner: params.owner } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.addBlocks !== undefined ? { addBlocks: params.addBlocks } : {}),
      ...(params.addBlockedBy !== undefined ? { addBlockedBy: params.addBlockedBy } : {}),
      ...(params.removeBlocks !== undefined ? { removeBlocks: params.removeBlocks } : {}),
      ...(params.removeBlockedBy !== undefined
        ? { removeBlockedBy: params.removeBlockedBy }
        : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    });
    return { task };
  });

  dispatcher.register("tasks.get", async (params) => ({
    task: store.get(params.sessionId, params.taskId),
  }));

  dispatcher.register("tasks.list", async (params) => ({
    tasks: store.list(params.sessionId, {
      includeDeleted: params.includeDeleted,
      ...(params.status !== undefined ? { status: params.status } : {}),
    }),
  }));

  dispatcher.register("tasks.delete", async (params) => ({
    task: await store.softDelete(params.sessionId, params.taskId),
  }));

  dispatcher.register("tasks.claim", async (params) => ({
    task: await store.claim(params.sessionId, params.taskId, params.owner),
  }));

  dispatcher.register("tasks.watch", async (params) => ({
    taskListId: store.resolveListId(params.sessionId),
  }));
}
