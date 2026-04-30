import { BaseTool } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { RestartBackend } from "./backend.js";

function formatResult(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

interface RestartInput extends Record<string, unknown> {
  reason?: string;
}

export class RestartGatewayTool extends BaseTool<RestartInput> {
  readonly name = "restart_gateway";
  readonly description = [
    "Restart the gateway process. Use this after writes that require a full",
    "restart to take effect — server.* config, llm.providers.*, plugins, or",
    "auth.tokens. The current chat session is persisted and resumes after the",
    "process comes back. The tool returns immediately; the actual restart fires",
    "~750ms later so this response reaches you. If the gateway can't guarantee",
    "a respawn (e.g. running directly without a supervisor or Docker restart",
    "policy), the tool errors instead of exiting — never assume success means",
    "the process will return until you've reconnected.",
  ].join(" ");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      reason: {
        type: "string",
        description:
          "Short human-readable reason — surfaced in logs and broadcast as the gateway.restarting event.",
      },
    },
  };
  readonly tags = ["restart", "dangerous"] as const;

  constructor(private readonly backend: RestartBackend) {
    super();
  }

  async run(input: RestartInput): Promise<ToolExecutorResult> {
    const reason =
      typeof input.reason === "string" && input.reason.trim().length > 0
        ? input.reason.trim()
        : "agent-requested restart";
    const result = await this.backend.requestRestart({ reason });
    return formatResult({
      ok: true,
      ...result,
      note: "The gateway is shutting down. Subsequent tool calls will fail until the process restarts and the client reconnects.",
    });
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerRestartTool(
  registry: { register(tool: AnyTool): unknown },
  backend: RestartBackend,
): void {
  registry.register(new RestartGatewayTool(backend) as unknown as AnyTool);
}
