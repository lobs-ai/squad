import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { EnvBackend } from "./backend.js";

type AnyTool = BaseTool<Record<string, unknown>>;

/** ── set_env ─────────────────────────────────────────────────────────── */

interface SetEnvInput extends Record<string, unknown> {
  name: string;
  value: string;
}

export class SetEnvTool extends BaseTool<SetEnvInput> {
  readonly name = "set_env";
  readonly description = [
    "Persist an environment variable on this gateway. The value goes into a",
    "0600 secrets file under <data_dir> AND into the running process's env",
    "(`process.env[name]`), so plugins, tools, and subprocesses see it",
    "immediately without restarting the gateway. Survives restarts. Use",
    "this whenever the user gives you a value that something on this host",
    "reads from `process.env` — API keys, bot tokens, OAuth client ids, db",
    "URLs, anything. **Never** tell the user to edit `.env` themselves.",
    "",
    "For *plugin* secrets, prefer `plugin_install` with a `secrets` map —",
    "it does the same persistence plus rolls back cleanly on failure. Use",
    "`set_env` for everything that isn't a plugin field.",
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Env var name. Convention: SHOUTY_SNAKE_CASE.",
      },
      value: {
        type: "string",
        description: "The literal value to store. Stored locally; never logged.",
      },
    },
    required: ["name", "value"],
  };
  readonly tags = ["write", "env-management"] as const;

  constructor(private readonly backend: EnvBackend) {
    super();
  }

  async run(input: SetEnvInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    if (!input.name || input.name.length === 0) {
      throw new Error("set_env: name is required");
    }
    if (typeof input.value !== "string") {
      throw new Error("set_env: value must be a string");
    }
    await this.backend.set(input.name, input.value);
    return `Set ${input.name} (${input.value.length} chars). Available now via process.env.`;
  }
}

/** ── unset_env ───────────────────────────────────────────────────────── */

interface UnsetEnvInput extends Record<string, unknown> {
  name: string;
}

export class UnsetEnvTool extends BaseTool<UnsetEnvInput> {
  readonly name = "unset_env";
  readonly description = [
    "Remove a stored environment variable. Idempotent. Note this does NOT",
    "unset the value already in the running process's env — operators may",
    "have set the same name explicitly via the shell or container, and we",
    "won't second-guess that. A restart picks up the change.",
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Env var name to remove." },
    },
    required: ["name"],
  };
  readonly tags = ["write", "env-management"] as const;

  constructor(private readonly backend: EnvBackend) {
    super();
  }

  async run(input: UnsetEnvInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    await this.backend.unset(input.name);
    return `Removed ${input.name} from the secret store.`;
  }
}

/** ── list_env_names ──────────────────────────────────────────────────── */

export class ListEnvNamesTool extends BaseTool {
  readonly name = "list_env_names";
  readonly description = [
    "List the names of env vars currently stored in the gateway's secret",
    "store. Values are NEVER returned (they're potential secrets). Use",
    "this to check whether a value is already set before asking the user",
    "for it again.",
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly tags = ["readonly", "env-management"] as const;

  constructor(private readonly backend: EnvBackend) {
    super();
  }

  async run(): Promise<ToolExecutorResult> {
    const names = await this.backend.listNames();
    if (names.length === 0) return "(no stored env entries)";
    return `Stored env names (values redacted):\n${names.map((n) => `  - ${n}`).join("\n")}`;
  }
}

/** ── registration helper ─────────────────────────────────────────────── */

export function registerEnvTools(
  registry: { register(tool: AnyTool): unknown },
  backend: EnvBackend,
): void {
  registry.register(new SetEnvTool(backend) as unknown as AnyTool);
  registry.register(new UnsetEnvTool(backend) as unknown as AnyTool);
  registry.register(new ListEnvNamesTool(backend) as unknown as AnyTool);
}
