import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type {
  CronBackend,
  DeliveryInput,
  ExecutionInput,
  PayloadInput,
  ScheduleInput,
  SessionTargetInput,
} from "./backend.js";
import { CRON_GUIDANCE } from "./prompt.js";

function formatResult(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

const scheduleSchema = {
  type: "object",
  oneOf: [
    {
      properties: {
        kind: { const: "cron" },
        expr: { type: "string", description: "5-field crontab, e.g. '0 9 * * 1-5'" },
        tz: { type: "string" },
        staggerMs: { type: "number" },
      },
      required: ["kind", "expr"],
    },
    {
      properties: {
        kind: { const: "interval" },
        everyMs: { type: "number", description: "Period in milliseconds" },
        anchor: { type: "string", description: "ISO timestamp anchor; default = now" },
      },
      required: ["kind", "everyMs"],
    },
    {
      properties: {
        kind: { const: "once" },
        at: { type: "string", description: "ISO timestamp when to fire" },
      },
      required: ["kind", "at"],
    },
  ],
} as const;

const promptBodySchema = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["user", "system"] },
          text: { type: "string" },
        },
        required: ["role", "text"],
      },
      minItems: 1,
      description:
        "Ordered list of user/system messages. user messages are concatenated into the user turn; system messages are folded into the system prompt for this run.",
    },
    skills: {
      type: "array",
      items: { type: "string" },
      description: "Skill ids whose instructions should be loaded for this run.",
    },
  },
  required: ["messages"],
} as const;

const payloadSchema = {
  type: "object",
  oneOf: [
    {
      properties: {
        kind: { const: "prompt" },
        ...promptBodySchema.properties,
      },
      required: ["kind", "messages"],
    },
    {
      properties: {
        kind: { const: "script" },
        command: { type: "string", description: "Executable to spawn (resolved via PATH or absolute path)." },
        args: { type: "array", items: { type: "string" } },
        cwd: {
          type: "string",
          description:
            "Working directory for the script. Defaults to the gateway workspace dir.",
        },
      },
      required: ["kind", "command"],
    },
    {
      properties: {
        kind: { const: "scriptThenPrompt" },
        command: { type: "string", description: "Executable to spawn first." },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        prompt: {
          ...promptBodySchema,
          description:
            "Agent turn run after the script. {{output}} placeholders in any message text are replaced with the script's stdout. If no message contains {{output}}, the stdout is appended as a final user message.",
        },
      },
      required: ["kind", "command", "prompt"],
    },
  ],
} as const;

const sessionSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["new", "isolated", "session"] },
    sessionId: { type: "string", description: "Required when kind === 'session'" },
  },
  required: ["kind"],
} as const;

const executionSchema = {
  type: "object",
  properties: {
    model: {
      type: ["string", "null"],
      description: "Override the gateway's default model for this job (e.g. claude-haiku-4-5)",
    },
    fallbacks: { type: "array", items: { type: "string" } },
    toolsAllow: { type: "array", items: { type: "string" } },
    timeoutSec: { type: "number" },
  },
} as const;

const deliverySchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      description:
        "Where to send the run output. Built-in: 'silent' (no delivery), 'dashboard' (open in chat UI), 'discord' (post to a channel — requires channelId). Any other string targets a plugin-registered handler (e.g. 'slack'); pass that handler's required fields under `extras`.",
    },
    channelId: {
      type: "string",
      description: "Required when kind === 'discord'. Discord channel id (snowflake).",
    },
    guildId: {
      type: "string",
      description: "Optional discord guild id.",
    },
    extras: {
      type: "object",
      additionalProperties: true,
      description:
        "Free-form fields forwarded to plugin-registered delivery handlers. e.g. { channel: '#alerts' } for a 'slack' handler.",
    },
  },
  required: ["kind"],
} as const;

// ── create_cron_job ──────────────────────────────────────────────────────────

interface CreateInput extends Record<string, unknown> {
  name: string;
  schedule: ScheduleInput;
  payload: PayloadInput;
  session?: SessionTargetInput;
  execution?: ExecutionInput;
  delivery?: DeliveryInput;
  enabled?: boolean;
}

export class CreateCronJobTool extends BaseTool<CreateInput> {
  readonly name = "create_cron_job";
  readonly description = [
    "Schedule a recurring or one-off cron job. Returns the created job (with id).",
    "",
    CRON_GUIDANCE,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Unique short label, e.g. 'morning-summary'" },
      enabled: { type: "boolean", description: "Default true" },
      schedule: scheduleSchema,
      payload: payloadSchema,
      session: sessionSchema,
      execution: executionSchema,
      delivery: deliverySchema,
    },
    required: ["name", "schedule", "payload"],
  };
  readonly tags = ["write"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: CreateInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const job = await this.backend.create({
      name: input.name,
      schedule: input.schedule,
      payload: input.payload,
      ...(input.session ? { session: input.session } : {}),
      ...(input.execution ? { execution: input.execution } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    });
    return formatResult({ job });
  }
}

// ── update_cron_job ──────────────────────────────────────────────────────────

interface UpdateInput extends Record<string, unknown> {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: ScheduleInput;
  payload?: PayloadInput;
  session?: SessionTargetInput;
  execution?: ExecutionInput;
  delivery?: DeliveryInput;
}

export class UpdateCronJobTool extends BaseTool<UpdateInput> {
  readonly name = "update_cron_job";
  readonly description = [
    "Update an existing cron job. Pass only the fields you want to change.",
    "Set `enabled: false` to pause without deleting; `true` to resume.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      enabled: { type: "boolean" },
      schedule: scheduleSchema,
      payload: payloadSchema,
      session: sessionSchema,
      execution: executionSchema,
      delivery: deliverySchema,
    },
    required: ["id"],
  };
  readonly tags = ["write"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: UpdateInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const job = await this.backend.update({
      id: input.id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.execution !== undefined ? { execution: input.execution } : {}),
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    });
    return formatResult({ job });
  }
}

// ── delete_cron_job ──────────────────────────────────────────────────────────

interface DeleteInput extends Record<string, unknown> {
  id: string;
}

export class DeleteCronJobTool extends BaseTool<DeleteInput> {
  readonly name = "delete_cron_job";
  readonly description =
    "Permanently delete a cron job. To stop it temporarily without removing it, call update_cron_job with enabled: false instead.";
  readonly inputSchema = {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  readonly tags = ["write"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: DeleteInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const result = await this.backend.delete(input.id);
    return formatResult(result);
  }
}

// ── list_cron_jobs ───────────────────────────────────────────────────────────

interface ListInput extends Record<string, unknown> {
  enabledOnly?: boolean;
}

export class ListCronJobsTool extends BaseTool<ListInput> {
  readonly name = "list_cron_jobs";
  readonly description = "List every cron job. Pass enabledOnly: true to filter out paused jobs.";
  readonly inputSchema = {
    type: "object" as const,
    properties: { enabledOnly: { type: "boolean" } },
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: ListInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const all = await this.backend.list();
    const jobs = input.enabledOnly ? all.filter((j) => j.enabled) : all;
    return formatResult({ jobs });
  }
}

// ── get_cron_job ─────────────────────────────────────────────────────────────

interface GetInput extends Record<string, unknown> {
  id: string;
}

export class GetCronJobTool extends BaseTool<GetInput> {
  readonly name = "get_cron_job";
  readonly description = "Fetch a single cron job by id, with its current runtime state.";
  readonly inputSchema = {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: GetInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const job = await this.backend.get(input.id);
    if (!job) throw new Error(`unknown cron job: ${input.id}`);
    return formatResult({ job });
  }
}

// ── run_cron_job ─────────────────────────────────────────────────────────────

interface RunInput extends Record<string, unknown> {
  id: string;
}

export class RunCronJobTool extends BaseTool<RunInput> {
  readonly name = "run_cron_job";
  readonly description =
    "Fire a cron job immediately, ignoring its schedule. Useful to verify a new job before waiting for the schedule to hit. Returns the sessionId (or null for script jobs).";
  readonly inputSchema = {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  readonly tags = ["write", "exec"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: RunInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const result = await this.backend.runNow(input.id);
    return formatResult(result);
  }
}

// ── get_cron_runs ────────────────────────────────────────────────────────────

interface RunsInput extends Record<string, unknown> {
  id: string;
  limit?: number;
  status?: "ok" | "error" | "skipped";
}

export class GetCronRunsTool extends BaseTool<RunsInput> {
  readonly name = "get_cron_runs";
  readonly description =
    "List recent runs of a cron job (newest first). Useful to check whether the schedule fired and whether it succeeded.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      limit: { type: "number", description: "Default 20, max 500" },
      status: { type: "string", enum: ["ok", "error", "skipped"] },
    },
    required: ["id"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(input: RunsInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const runs = await this.backend.runs({
      id: input.id,
      ...(input.limit !== undefined ? { limit: input.limit } : { limit: 20 }),
      ...(input.status ? { status: input.status } : {}),
    });
    return formatResult({ runs });
  }
}

// ── list_delivery_kinds ──────────────────────────────────────────────────────

interface ListKindsInput extends Record<string, unknown> {}

export class ListDeliveryKindsTool extends BaseTool<ListKindsInput> {
  readonly name = "list_delivery_kinds";
  readonly description = [
    "List the delivery handler kinds the gateway can route a cron job's output to.",
    "Returns the built-ins (silent, dashboard, discord) plus anything plugins have",
    "registered (slack, webhook, …). Call this before creating a cron job whose",
    "delivery is anything other than silent/dashboard, so the kind you pass actually",
    "matches a registered handler. If the user asks for, say, slack and 'slack' is",
    "not in the list, the slack plugin is not loaded — tell them rather than fail",
    "silently at fire time.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: CronBackend) {
    super();
  }

  async run(_input: ListKindsInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const kinds = await this.backend.listDeliveryKinds();
    return formatResult({ kinds });
  }
}

// ── registration helper ─────────────────────────────────────────────────────

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerCronTools(
  registry: { register(tool: AnyTool): unknown },
  backend: CronBackend,
): void {
  registry.register(new CreateCronJobTool(backend) as unknown as AnyTool);
  registry.register(new UpdateCronJobTool(backend) as unknown as AnyTool);
  registry.register(new DeleteCronJobTool(backend) as unknown as AnyTool);
  registry.register(new ListCronJobsTool(backend) as unknown as AnyTool);
  registry.register(new GetCronJobTool(backend) as unknown as AnyTool);
  registry.register(new RunCronJobTool(backend) as unknown as AnyTool);
  registry.register(new GetCronRunsTool(backend) as unknown as AnyTool);
  registry.register(new ListDeliveryKindsTool(backend) as unknown as AnyTool);
}
