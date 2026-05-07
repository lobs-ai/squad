import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { AppBackend } from "./backend.js";

function formatResult(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

interface ExposeAppInput extends Record<string, unknown> {
  name?: string;
  title?: string;
  description?: string;
  port?: number;
  host?: string;
  scope?: "persist" | "session";
}

/**
 * Register a child-process-hosted web app at `/apps/<name>/*` on the gateway.
 * The app must already be listening on `127.0.0.1:<port>` before the agent
 * calls this — the tool does NOT spawn anything itself.
 */
export class ExposeAppTool extends BaseTool<ExposeAppInput> {
  readonly name = "expose_app";
  readonly description = [
    "Register a locally-running web app so the dashboard proxies it at",
    "`/apps/<name>/*`. The app must already be listening on the given port",
    "(use `exec` to spawn it first). The dashboard hits `GET /squad/health`",
    "every ~10s for status and `GET /squad/info` once for metadata — both",
    "are auto-mounted by `@squad/app-sdk`. By default the registration",
    "persists until the process exits or `unexpose_app` is called; pass",
    "`scope: \"session\"` to bind it to the current chat session so it cleans",
    "up on `session.end`.",
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description:
          "URL slug under /apps/. Must match [a-z0-9][a-z0-9-]*. Owns every subpath.",
      },
      title: {
        type: "string",
        description: "Human-readable title shown in the dashboard apps list.",
      },
      description: {
        type: "string",
        description: "Optional one-liner shown beneath the title.",
      },
      port: {
        type: "number",
        description: "TCP port the app is listening on (loopback only).",
      },
      host: {
        type: "string",
        description: "Loopback host. Defaults to 127.0.0.1; rarely needs changing.",
      },
      scope: {
        type: "string",
        enum: ["persist", "session"],
        description:
          "persist (default): registration survives until unexposed or process gone. session: dropped automatically when the current session ends.",
      },
    },
    required: ["name", "title", "port"],
  };
  readonly tags = ["apps"] as const;

  constructor(private readonly backend: AppBackend) {
    super();
  }

  async run(input: ExposeAppInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    if (!input.name) throw new Error("name is required");
    if (!input.title) throw new Error("title is required");
    if (typeof input.port !== "number") throw new Error("port is required");
    const sessionId = ctx.meta?.["sessionId"] as string | undefined;
    const record = this.backend.register({
      name: input.name,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      port: input.port,
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    return formatResult({
      ok: true,
      app: record,
      url: `/apps/${record.name}/`,
      note: "App is reachable in the dashboard once GET /squad/health responds 200.",
    });
  }
}

interface UnexposeAppInput extends Record<string, unknown> {
  name?: string;
}

export class UnexposeAppTool extends BaseTool<UnexposeAppInput> {
  readonly name = "unexpose_app";
  readonly description =
    "Drop a previously-registered app from the gateway. Doesn't kill the underlying process — use `exec` (e.g. `kill <pid>`) for that.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Name passed to expose_app." },
    },
    required: ["name"],
  };
  readonly tags = ["apps"] as const;

  constructor(private readonly backend: AppBackend) {
    super();
  }

  async run(input: UnexposeAppInput): Promise<ToolExecutorResult> {
    if (!input.name) throw new Error("name is required");
    const ok = this.backend.unregister(input.name);
    return formatResult({ ok, name: input.name });
  }
}

export class ListAppsTool extends BaseTool<Record<string, never>> {
  readonly name = "list_apps";
  readonly description =
    "List every registered app — name, title, port, scope, and last health probe result.";
  readonly inputSchema = { type: "object" as const, properties: {} };
  readonly tags = ["apps"] as const;

  constructor(private readonly backend: AppBackend) {
    super();
  }

  async run(): Promise<ToolExecutorResult> {
    return formatResult({ apps: this.backend.list() });
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerAppTools(
  registry: { register(tool: AnyTool): unknown },
  backend: AppBackend,
): void {
  registry.register(new ExposeAppTool(backend) as unknown as AnyTool);
  registry.register(new UnexposeAppTool(backend) as unknown as AnyTool);
  registry.register(new ListAppsTool(backend) as unknown as AnyTool);
}
