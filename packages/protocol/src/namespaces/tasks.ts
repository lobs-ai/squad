import { z } from "zod";

export const taskStatusSchema = z.enum(["pending", "in_progress", "completed", "deleted"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  taskListId: z.string(), // derived from session-tree root
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().optional(),
  owner: z.string().nullable(),
  status: taskStatusSchema,
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

// tasks.create
export const tasksCreateParams = z.object({
  sessionId: z.string(),
  subject: z.string().min(1),
  description: z.string(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export const tasksCreateResult = z.object({ task: taskSchema });

// tasks.update
export const tasksUpdateParams = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  subject: z.string().optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  owner: z.string().nullable().optional(),
  status: taskStatusSchema.optional(),
  addBlocks: z.array(z.string()).optional(),
  addBlockedBy: z.array(z.string()).optional(),
  removeBlocks: z.array(z.string()).optional(),
  removeBlockedBy: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export const tasksUpdateResult = z.object({ task: taskSchema });

// tasks.get
export const tasksGetParams = z.object({ sessionId: z.string(), taskId: z.string() });
export const tasksGetResult = z.object({ task: taskSchema });

// tasks.list
export const tasksListParams = z.object({
  sessionId: z.string(),
  includeDeleted: z.boolean().default(false),
  status: z.array(taskStatusSchema).optional(),
});
export const tasksListResult = z.object({ tasks: z.array(taskSchema) });

// tasks.delete (soft delete)
export const tasksDeleteParams = z.object({ sessionId: z.string(), taskId: z.string() });
export const tasksDeleteResult = z.object({ task: taskSchema });

// tasks.claim (convenience for owner := self + status := in_progress)
export const tasksClaimParams = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  owner: z.string(),
});
export const tasksClaimResult = z.object({ task: taskSchema });

// tasks.watch (acknowledged by gateway; updates flow via events)
export const tasksWatchParams = z.object({ sessionId: z.string() });
export const tasksWatchResult = z.object({ taskListId: z.string() });

export const taskMethods = {
  "tasks.create": { params: tasksCreateParams, result: tasksCreateResult },
  "tasks.update": { params: tasksUpdateParams, result: tasksUpdateResult },
  "tasks.get": { params: tasksGetParams, result: tasksGetResult },
  "tasks.list": { params: tasksListParams, result: tasksListResult },
  "tasks.delete": { params: tasksDeleteParams, result: tasksDeleteResult },
  "tasks.claim": { params: tasksClaimParams, result: tasksClaimResult },
  "tasks.watch": { params: tasksWatchParams, result: tasksWatchResult },
} as const;

// ── Events ────────────────────────────────────────────────────────────────────

export const taskCreatedEvent = z.object({ task: taskSchema });
export const taskUpdatedEvent = z.object({ task: taskSchema });
export const taskDeletedEvent = z.object({ task: taskSchema });

export const taskEvents = {
  "tasks.created": taskCreatedEvent,
  "tasks.updated": taskUpdatedEvent,
  "tasks.deleted": taskDeletedEvent,
} as const;
