import { describe, it, expect, beforeEach } from "vitest";
import {
  CreateTaskTool,
  UpdateTaskTool,
  ListTasksTool,
  GetTaskTool,
  registerTaskTools,
} from "./tools.js";
import { ToolRegistry } from "../registry.js";
import type { Task, TaskBackend, TaskStatus } from "./backend.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    taskListId: "tl",
    subject: "s",
    description: "d",
    owner: null,
    status: "pending",
    blocks: [],
    blockedBy: [],
    createdAt: "2026-04-23T00:00:00Z",
    updatedAt: "2026-04-23T00:00:00Z",
    ...overrides,
  };
}

function fakeBackend(): TaskBackend & {
  calls: { create: unknown[]; update: unknown[]; list: unknown[]; get: unknown[] };
} {
  const calls = { create: [] as unknown[], update: [] as unknown[], list: [] as unknown[], get: [] as unknown[] };
  const store = new Map<string, Task>();
  return {
    calls,
    async create(input) {
      calls.create.push(input);
      const t = makeTask({ id: `task-${store.size + 1}`, subject: input.subject, description: input.description });
      store.set(t.id, t);
      return t;
    },
    async update(input) {
      calls.update.push(input);
      const t = store.get(input.taskId) ?? makeTask({ id: input.taskId });
      const next: Task = {
        ...t,
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.status !== undefined ? { status: input.status as TaskStatus } : {}),
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
      };
      store.set(next.id, next);
      return next;
    },
    async get(_sessionId, taskId) {
      calls.get.push({ sessionId: _sessionId, taskId });
      const t = store.get(taskId);
      if (!t) throw new Error("not found");
      return t;
    },
    async list(sessionId, opts) {
      calls.list.push({ sessionId, opts });
      return Array.from(store.values());
    },
  };
}

describe("task tools", () => {
  let backend: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    backend = fakeBackend();
  });

  it("throws when sessionId is missing from context", async () => {
    const tool = new CreateTaskTool(backend);
    await expect(tool.run({ subject: "x", description: "y" }, { cwd: "/tmp" })).rejects.toThrow(
      /sessionId/,
    );
  });

  it("create_task only forwards keys that were provided", async () => {
    const tool = new CreateTaskTool(backend);
    await tool.run(
      { subject: "hello", description: "world" },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    expect(backend.calls.create).toHaveLength(1);
    const call = backend.calls.create[0] as Record<string, unknown>;
    expect(call).toEqual({ sessionId: "s1", subject: "hello", description: "world" });
    expect(Object.keys(call)).not.toContain("activeForm");
    expect(Object.keys(call)).not.toContain("metadata");
  });

  it("create_task forwards optional fields when set", async () => {
    const tool = new CreateTaskTool(backend);
    await tool.run(
      {
        subject: "a",
        description: "b",
        activeForm: "Doing a",
        blockedBy: ["x"],
        metadata: { k: 1 },
      },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    const call = backend.calls.create[0] as Record<string, unknown>;
    expect(call.activeForm).toBe("Doing a");
    expect(call.blockedBy).toEqual(["x"]);
    expect(call.metadata).toEqual({ k: 1 });
  });

  it("update_task strips undefined fields and passes through owner: null", async () => {
    await backend.create({ sessionId: "s1", subject: "a", description: "b" });
    const tool = new UpdateTaskTool(backend);
    await tool.run(
      { taskId: "task-1", status: "completed", owner: null },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    const call = backend.calls.update[0] as Record<string, unknown>;
    expect(call).toEqual({ sessionId: "s1", taskId: "task-1", status: "completed", owner: null });
  });

  it("list_tasks forwards includeDeleted + status filter", async () => {
    const tool = new ListTasksTool(backend);
    await tool.run(
      { includeDeleted: true, status: ["pending", "in_progress"] },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    const call = backend.calls.list[0] as { opts: Record<string, unknown> };
    expect(call.opts).toEqual({ includeDeleted: true, status: ["pending", "in_progress"] });
  });

  it("get_task returns a stringified task payload", async () => {
    const created = await backend.create({ sessionId: "s1", subject: "q", description: "r" });
    const tool = new GetTaskTool(backend);
    const result = await tool.run({ taskId: created.id }, { cwd: "/tmp", meta: { sessionId: "s1" } });
    expect(result).toMatchObject({ result: expect.any(String) });
    const parsed = JSON.parse((result as { result: string }).result);
    expect(parsed.task.id).toBe(created.id);
  });

  it("registerTaskTools wires all four tools into a ToolRegistry", () => {
    const reg = new ToolRegistry();
    registerTaskTools(reg, backend);
    expect(reg.names().sort()).toEqual(
      ["create_task", "get_task", "list_tasks", "update_task"].sort(),
    );
  });
});
