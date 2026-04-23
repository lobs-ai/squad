import { BaseTool } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { ConfigBackend } from "./backend.js";

function formatResult(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

const PATH_GUIDANCE = [
  "Paths are dot-separated. Numeric segments address array indices.",
  "Examples: `llm.primary.model`, `llm.fallbacks.0.model`,",
  "`subagents.max_concurrent_global`, `chat.delivery.mode`, `auth.tokens.0.scopes`,",
  "`policy.approvals.require_for_tags`.",
  "Use list_config_paths to discover what's currently set.",
].join(" ");

// ── get_config ───────────────────────────────────────────────────────────────

interface GetInput extends Record<string, unknown> {
  path?: string;
}

export class GetConfigTool extends BaseTool<GetInput> {
  readonly name = "get_config";
  readonly description = [
    "Read a value from the gateway config. Omit `path` to get the full config",
    "tree. " + PATH_GUIDANCE,
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Dot-path into the config (empty for full tree)" },
    },
  };
  readonly tags = ["readonly", "config"] as const;

  constructor(private readonly backend: ConfigBackend) {
    super();
  }

  async run(input: GetInput): Promise<ToolExecutorResult> {
    if (input.path && input.path.length > 0) {
      const value = await this.backend.getValue(input.path);
      return formatResult({ path: input.path, value });
    }
    const config = await this.backend.get();
    return formatResult({ config });
  }
}

// ── set_config ───────────────────────────────────────────────────────────────

interface SetInput extends Record<string, unknown> {
  path: string;
  value: unknown;
}

export class SetConfigTool extends BaseTool<SetInput> {
  readonly name = "set_config";
  readonly description = [
    "Write a value to the gateway config, persisting to config.json. The new",
    "config is validated through the same schema used at boot; invalid values",
    "are rejected without touching disk. Some changes (subagent pool limits,",
    "server port, provider keys, loaded plugins) only take effect on restart —",
    "the return payload flags these. " + PATH_GUIDANCE,
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Dot-path into the config" },
      value: {
        description: "The new value. May be any JSON-compatible type (string, number, boolean, object, array).",
      },
    },
    required: ["path", "value"],
  };
  readonly tags = ["write", "config"] as const;

  constructor(private readonly backend: ConfigBackend) {
    super();
  }

  async run(input: SetInput): Promise<ToolExecutorResult> {
    const config = await this.backend.setValue(input.path, input.value);
    return formatResult({
      ok: true,
      path: input.path,
      config,
      note: "Persisted to config.json. Restart required for: server.*, subagents.*, llm.providers.*, plugins, auth.tokens.",
    });
  }
}

// ── unset_config ─────────────────────────────────────────────────────────────

interface UnsetInput extends Record<string, unknown> {
  path: string;
}

export class UnsetConfigTool extends BaseTool<UnsetInput> {
  readonly name = "unset_config";
  readonly description = [
    "Remove a key (or array index) from the gateway config and persist the",
    "result. Fails if the remaining config would be invalid. " + PATH_GUIDANCE,
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      path: { type: "string", description: "Dot-path into the config" },
    },
    required: ["path"],
  };
  readonly tags = ["write", "config"] as const;

  constructor(private readonly backend: ConfigBackend) {
    super();
  }

  async run(input: UnsetInput): Promise<ToolExecutorResult> {
    const config = await this.backend.unsetValue(input.path);
    return formatResult({ ok: true, removed: input.path, config });
  }
}

// ── list_config_paths ────────────────────────────────────────────────────────

export class ListConfigPathsTool extends BaseTool<Record<string, unknown>> {
  readonly name = "list_config_paths";
  readonly description =
    "List every leaf dot-path currently present in the gateway config. Use this to discover what's configurable before calling set_config.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly tags = ["readonly", "config"] as const;

  constructor(private readonly backend: ConfigBackend) {
    super();
  }

  async run(): Promise<ToolExecutorResult> {
    const paths = await this.backend.listPaths();
    return formatResult({ paths });
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerConfigTools(
  registry: { register(tool: AnyTool): unknown },
  backend: ConfigBackend,
): void {
  registry.register(new GetConfigTool(backend) as unknown as AnyTool);
  registry.register(new SetConfigTool(backend) as unknown as AnyTool);
  registry.register(new UnsetConfigTool(backend) as unknown as AnyTool);
  registry.register(new ListConfigPathsTool(backend) as unknown as AnyTool);
}
