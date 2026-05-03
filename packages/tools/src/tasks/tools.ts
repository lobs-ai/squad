import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { TaskBackend, TaskStatus } from "./backend.js";
import { TASK_GUIDANCE } from "./prompt.js";

function sessionIdFrom(ctx: ToolContext): string {
  const sid = (ctx.meta?.sessionId as string | undefined) ?? undefined;
  if (!sid) {
    throw new Error("task tools require `sessionId` in the agent context");
  }
  return sid;
}

function formatResult(_ok: boolean, payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

// ── create_task ──────────────────────────────────────────────────────────────

interface CreateInput extends Record<string, unknown> {
  subject: string;
  description: string;
  activeForm?: string;
  blockedBy?: string[];
  blocks?: string[];
  metadata?: Record<string, unknown>;
}

export class CreateTaskTool extends BaseTool<CreateInput> {
  readonly name = "create_task";
  readonly description = [
    "Add a new task to the session tree's shared task list. Returns the task id.",
    "",
    TASK_GUIDANCE,
  ].join("\n");

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      subject: { type: "string", description: "Short imperative title, e.g. 'Fix login redirect'" },
      description: { type: "string", description: "Full detail of what needs to be done" },
      activeForm: {
        type: "string",
        description: "Present-continuous form for the spinner, e.g. 'Fixing login redirect'",
      },
      blockedBy: { type: "array", items: { type: "string" } },
      blocks: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
    },
    required: ["subject", "description"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: TaskBackend) {
    super();
  }

  async run(input: CreateInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const task = await this.backend.create({
      sessionId: sessionIdFrom(ctx),
      subject: input.subject,
      description: input.description,
      ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
      ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
      ...(input.blocks !== undefined ? { blocks: input.blocks } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    return formatResult(true, { task });
  }
}

// ── update_task ──────────────────────────────────────────────────────────────

interface UpdateInput extends Record<string, unknown> {
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

export class UpdateTaskTool extends BaseTool<UpdateInput> {
  readonly name = "update_task";
  readonly description = [
    "Update a task: change status, subject, description, owner, or dependencies.",
    "Claim a task by setting owner (typically to yourself) and status to in_progress in the same call.",
    "",
    TASK_GUIDANCE,
  ].join("\n");

  readonly inputSchema = {
    type: "object" as const,
    properties: {
      taskId: { type: "string" },
      subject: { type: "string" },
      description: { type: "string" },
      activeForm: { type: "string" },
      owner: { type: ["string", "null"] },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
      addBlocks: { type: "array", items: { type: "string" } },
      addBlockedBy: { type: "array", items: { type: "string" } },
      removeBlocks: { type: "array", items: { type: "string" } },
      removeBlockedBy: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
    },
    required: ["taskId"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: TaskBackend) {
    super();
  }

  async run(input: UpdateInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const task = await this.backend.update({
      sessionId: sessionIdFrom(ctx),
      taskId: input.taskId,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.addBlocks !== undefined ? { addBlocks: input.addBlocks } : {}),
      ...(input.addBlockedBy !== undefined ? { addBlockedBy: input.addBlockedBy } : {}),
      ...(input.removeBlocks !== undefined ? { removeBlocks: input.removeBlocks } : {}),
      ...(input.removeBlockedBy !== undefined
        ? { removeBlockedBy: input.removeBlockedBy }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    return formatResult(true, { task });
  }
}

// ── list_tasks ───────────────────────────────────────────────────────────────

interface ListInput extends Record<string, unknown> {
  includeDeleted?: boolean;
  status?: TaskStatus[];
}

export class ListTasksTool extends BaseTool<ListInput> {
  readonly name = "list_tasks";
  readonly description =
    "List the current tasks in the session tree's shared task list (ordered by creation time).";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      includeDeleted: { type: "boolean" },
      status: {
        type: "array",
        items: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
      },
    },
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: TaskBackend) {
    super();
  }

  async run(input: ListInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const tasks = await this.backend.list(sessionIdFrom(ctx), {
      ...(input.includeDeleted !== undefined ? { includeDeleted: input.includeDeleted } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    return formatResult(true, { tasks });
  }
}

// ── get_task ─────────────────────────────────────────────────────────────────

interface GetInput extends Record<string, unknown> {
  taskId: string;
}

export class GetTaskTool extends BaseTool<GetInput> {
  readonly name = "get_task";
  readonly description = "Fetch a single task by id (useful after a stale-read).";
  readonly inputSchema = {
    type: "object" as const,
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: TaskBackend) {
    super();
  }

  async run(input: GetInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const task = await this.backend.get(sessionIdFrom(ctx), input.taskId);
    return formatResult(true, { task });
  }
}

// Type-erase per-tool input shapes so callers accept any BaseTool. The
// ToolRegistry uses each tool's inputSchema for validation — TypeScript
// parametrization is strictly for authoring ergonomics.
type AnyTool = BaseTool<Record<string, unknown>>;

export function registerTaskTools(
  registry: { register(tool: AnyTool): unknown },
  backend: TaskBackend,
): void {
  registry.register(new CreateTaskTool(backend) as unknown as AnyTool);
  registry.register(new UpdateTaskTool(backend) as unknown as AnyTool);
  registry.register(new ListTasksTool(backend) as unknown as AnyTool);
  registry.register(new GetTaskTool(backend) as unknown as AnyTool);
}
