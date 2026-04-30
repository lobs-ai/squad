import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { SubagentBackend } from "./backend.js";

interface SpawnSubagentInput extends Record<string, unknown> {
  /** Registered subagent name. Omit for an ad-hoc spawn. */
  subagent?: string;
  /** First user message handed to the subagent. */
  prompt?: string;
  /** Optional structured payload. Stringified into the first user message. */
  input?: unknown;
  /** Telemetry label for ad-hoc spawns (no effect for named spawns). */
  name?: string;
  model?: string;
  wait?: boolean;
  toolsets?: string[];
  tools?: string[];
}

export class SpawnSubagentTool extends BaseTool<SpawnSubagentInput> {
  readonly name = "spawn_subagent";
  readonly description = [
    "Delegate work to a fresh subagent. Two ways to call:",
    "",
    "  • **Ad-hoc** — pass `prompt` plus optional `tools` / `toolsets` /",
    "    `model` / `name`. No registration needed. The subagent runs with the",
    "    Squad system prompt and your prompt as the first user message. No",
    "    SOUL/USER/MEMORY is loaded — it's a one-shot worker.",
    "",
    "  • **Named** — pass `subagent` to spawn a registered definition (see",
    "    `create_subagent`). It uses its own SOUL/USER/MEMORY under",
    "    `.squad/subagents/<name>/` and the model/tools you registered.",
    "",
    "Pass `wait: true` to get the final result inline. Pass `wait: false`",
    "(default) to fan out — the tool returns a sessionId immediately and the",
    "subagent streams on its own subscription topic.",
    "",
    "Subagents share the parent's task list. Put enough detail in the prompt",
    "(and any related task row) for the subagent to pick the work up cold.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      subagent: {
        type: "string",
        description: "Registered subagent name. Omit for ad-hoc.",
      },
      prompt: {
        type: "string",
        description:
          "First user message handed to the subagent. Required for ad-hoc spawns.",
      },
      input: {
        description: "Optional structured payload prepended to the first message.",
      },
      name: {
        type: "string",
        description: "Telemetry label for ad-hoc spawns.",
      },
      model: { type: "string", description: "Model id (overrides the named def)" },
      wait: { type: "boolean", description: "Await the final result inline" },
      toolsets: {
        type: "array",
        items: { type: "string" },
        description: "Toolset bundles unioned with the definition's tools",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Tool ids unioned with the definition's tools",
      },
    },
  };
  readonly tags = ["subagent"] as const;

  constructor(private readonly backend: SubagentBackend) {
    super();
  }

  async run(input: SpawnSubagentInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const parentSessionId = ctx.meta?.sessionId as string | undefined;
    if (!parentSessionId) {
      throw new Error("spawn_subagent requires `sessionId` in the agent context");
    }
    if (!input.subagent && !input.prompt) {
      throw new Error(
        "spawn_subagent: provide either `subagent` (named) or `prompt` (ad-hoc)",
      );
    }
    const { sessionId, result, succeeded } = await this.backend.spawn({
      parentSessionId,
      ...(input.subagent !== undefined ? { subagent: input.subagent } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.model !== undefined ? { modelOverride: input.model } : {}),
      ...(input.toolsets !== undefined ? { toolsets: input.toolsets } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      wait: input.wait ?? false,
    });
    return {
      result: JSON.stringify(
        {
          sessionId,
          ...(result !== undefined ? { result } : {}),
          ...(succeeded !== undefined ? { succeeded } : {}),
        },
        null,
        2,
      ),
    };
  }
}

// ── create_subagent ──────────────────────────────────────────────────────────

interface CreateSubagentInput extends Record<string, unknown> {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  toolsets?: string[];
  systemPrompt?: string;
  limits?: { maxTokens?: number; maxToolCalls?: number; timeoutMs?: number };
  inputSchema?: Record<string, unknown>;
  overwrite?: boolean;
}

export class CreateSubagentTool extends BaseTool<CreateSubagentInput> {
  readonly name = "create_subagent";
  readonly description = [
    "Register a reusable subagent. The new definition is live immediately —",
    "no restart — and persists across gateway restarts.",
    "",
    "On first creation the subagent gets its own core directory at",
    "`.squad/subagents/<name>/` with seeded SOUL.md / USER.md / MEMORY.md.",
    "Its system prompt is always the Squad system prompt; per-subagent",
    "character lives in its own SOUL.md, which it can edit.",
    "",
    "If the subagent already exists, pass `overwrite: true` to replace it.",
    "Use `spawn_subagent` to invoke it; use `delete_subagent` to remove it.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Unique subagent name" },
      description: { type: "string", description: "What this subagent is for" },
      model: { type: "string", description: "Model id (defaults to the gateway primary)" },
      tools: { type: "array", items: { type: "string" }, description: "Tool ids" },
      toolsets: {
        type: "array",
        items: { type: "string" },
        description: "Toolset bundles to include",
      },
      systemPrompt: {
        type: "string",
        description: "Optional preface seeded into SOUL.md on first create",
      },
      limits: {
        type: "object",
        properties: {
          maxTokens: { type: "number" },
          maxToolCalls: { type: "number" },
          timeoutMs: { type: "number" },
        },
      },
      inputSchema: {
        type: "object",
        description: "JSON Schema describing the structured input",
      },
      overwrite: { type: "boolean", description: "Replace if a definition with this name exists" },
    },
    required: ["name", "description"],
  };
  readonly tags = ["subagent", "write"] as const;

  constructor(private readonly backend: SubagentBackend) {
    super();
  }

  async run(input: CreateSubagentInput): Promise<ToolExecutorResult> {
    const out = await this.backend.createDefinition(input);
    return {
      result: JSON.stringify(
        {
          ok: true,
          definition: out.definition,
          coreDir: out.coreDir,
          note: "Live now. Spawn it with spawn_subagent({subagent: \"" + out.definition.name + "\"}).",
        },
        null,
        2,
      ),
    };
  }
}

// ── delete_subagent ──────────────────────────────────────────────────────────

interface DeleteSubagentInput extends Record<string, unknown> {
  name: string;
}

export class DeleteSubagentTool extends BaseTool<DeleteSubagentInput> {
  readonly name = "delete_subagent";
  readonly description =
    "Remove a registered subagent. The per-name core directory is left in place so a future re-create keeps its memory.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Registered subagent name" },
    },
    required: ["name"],
  };
  readonly tags = ["subagent", "write"] as const;

  constructor(private readonly backend: SubagentBackend) {
    super();
  }

  async run(input: DeleteSubagentInput): Promise<ToolExecutorResult> {
    const out = await this.backend.deleteDefinition(input.name);
    return { result: JSON.stringify(out, null, 2) };
  }
}

// ── list_subagents ───────────────────────────────────────────────────────────

export class ListSubagentsTool extends BaseTool<Record<string, unknown>> {
  readonly name = "list_subagents";
  readonly description = "List every registered subagent and its description.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly tags = ["subagent", "readonly"] as const;

  constructor(private readonly backend: SubagentBackend) {
    super();
  }

  async run(): Promise<ToolExecutorResult> {
    return {
      result: JSON.stringify({ subagents: this.backend.listDefinitions() }, null, 2),
    };
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerSpawnSubagentTool(
  registry: { register(tool: AnyTool): unknown },
  backend: SubagentBackend,
): void {
  registry.register(new SpawnSubagentTool(backend) as unknown as AnyTool);
  registry.register(new CreateSubagentTool(backend) as unknown as AnyTool);
  registry.register(new DeleteSubagentTool(backend) as unknown as AnyTool);
  registry.register(new ListSubagentsTool(backend) as unknown as AnyTool);
}

export function registerSubagentTools(
  registry: { register(tool: AnyTool): unknown },
  backend: SubagentBackend,
): void {
  registerSpawnSubagentTool(registry, backend);
}
