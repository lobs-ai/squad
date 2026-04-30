import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { SubagentBackend } from "./backend.js";

interface SpawnSubagentInput extends Record<string, unknown> {
  subagent: string;
  input: unknown;
  model?: string;
  wait?: boolean;
  toolsets?: string[];
  tools?: string[];
}

export class SpawnSubagentTool extends BaseTool<SpawnSubagentInput> {
  readonly name = "spawn_subagent";
  readonly description = [
    "Spawn a named, reusable subagent. Use for delegated work — research,",
    "code review, data analysis — where a purpose-built worker with its",
    "own model/tools/prompt is cheaper or better than doing it inline.",
    "",
    "Pass `wait: true` to get the final result inline. Pass `wait: false`",
    "(default) to fan out — the tool returns a sessionId immediately and",
    "the subagent streams on its own subscription topic.",
    "",
    "Subagents inherit the tree's task list. Put enough detail in the",
    "task row for the subagent to pick it up cold.",
    "",
    "Optional `toolsets` extend the subagent's tool list with curated",
    "bundles registered by plugins (see toolsets.list). Optional `tools`",
    "appends individual tool names. Both union with the definition's tools.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      subagent: { type: "string", description: "Registered subagent name" },
      input: { description: "Input payload to pass to the subagent" },
      model: { type: "string", description: "Override the definition's model" },
      wait: { type: "boolean", description: "Await the final result inline" },
      toolsets: {
        type: "array",
        items: { type: "string" },
        description: "Toolset bundles to union with the definition's tools",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Extra tool names to union with the definition's tools",
      },
    },
    required: ["subagent", "input"],
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
    const { sessionId, result, succeeded } = await this.backend.spawn({
      parentSessionId,
      subagent: input.subagent,
      input: input.input,
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

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerSpawnSubagentTool(
  registry: { register(tool: AnyTool): unknown },
  backend: SubagentBackend,
): void {
  registry.register(new SpawnSubagentTool(backend) as unknown as AnyTool);
}
