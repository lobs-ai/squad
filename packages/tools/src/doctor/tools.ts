import { BaseTool } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { DoctorBackend } from "./backend.js";

function format(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

interface DoctorInput extends Record<string, unknown> {
  action: "list" | "run" | "fix";
  /** For `run`: limit to specific check ids. Omit to run everything. */
  ids?: string[];
  /** For `fix`: which check to repair. */
  id?: string;
  /** For `fix`: preview what would change without applying. */
  dryRun?: boolean;
}

export class SquadDoctorTool extends BaseTool<DoctorInput> {
  readonly name = "squad_doctor";
  readonly description = [
    "Diagnose and repair the squad gateway. Runs a battery of checks across",
    "memory, database, LLM providers, filesystem, plugins, MCP, channels,",
    "subagents, and routines, and applies their fixes when possible.",
    "",
    "Actions:",
    "  • list — show every available check (id, category, fixable, dependsOn).",
    "  • run  — run all checks (or a subset via `ids`) and return diagnoses",
    "          ranked by severity. Use this first to find what's broken.",
    "  • fix  — apply the auto-repair for one fixable check by `id`. Set",
    "          `dryRun: true` to see what the fix would change without",
    "          applying it. Fixes whose dependsOn checks are still in error",
    "          are refused with `blockedBy` populated.",
    "",
    "Use this when the user reports something not working (e.g. \"memory",
    "isn't saving\", \"the agent can't reach the model\") OR proactively at",
    "the start of a debugging session. Always `run` before `fix` so you act",
    "on a fresh diagnosis.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "run", "fix"] as const },
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Restrict `run` to these check ids. Ignored for other actions.",
      },
      id: {
        type: "string",
        description: "Required for `fix` — the check id to repair.",
      },
      dryRun: {
        type: "boolean",
        description:
          "For `fix`: preview the changes without applying them (`applied=false`).",
      },
    },
    required: ["action"],
  };
  readonly tags = ["readonly", "diagnostic"] as const;

  constructor(private readonly backend: DoctorBackend) {
    super();
  }

  async run(input: DoctorInput): Promise<ToolExecutorResult> {
    switch (input.action) {
      case "list":
        return format({ checks: this.backend.list() });
      case "run": {
        const report = await this.backend.run(input.ids);
        return format(report);
      }
      case "fix": {
        if (!input.id || typeof input.id !== "string") {
          throw new Error('squad_doctor: action="fix" requires `id`');
        }
        const outcome = await this.backend.fix(input.id, {
          dryRun: input.dryRun === true,
        });
        return format(outcome);
      }
      default:
        throw new Error(`squad_doctor: unknown action "${String(input.action)}"`);
    }
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerSquadDoctorTool(
  registry: { register(tool: AnyTool): unknown },
  backend: DoctorBackend,
): void {
  registry.register(new SquadDoctorTool(backend) as unknown as AnyTool);
}
