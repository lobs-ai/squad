import type { ToolGroup } from "../groups.js";

export type { SubagentBackend } from "./backend.js";
export {
  SpawnSubagentTool,
  CreateSubagentTool,
  DeleteSubagentTool,
  ListSubagentsTool,
  registerSpawnSubagentTool,
  registerSubagentTools,
} from "./tools.js";

/** Lazy-loadable tool group for spawning and managing subagents. */
export const subagentsGroup: ToolGroup = {
  name: "subagents",
  description:
    "Spawn ad-hoc or named subagents, and create reusable ones at runtime — for delegated or parallelizable work",
  toolNames: [
    "spawn_subagent",
    "create_subagent",
    "delete_subagent",
    "list_subagents",
  ],
  guidance: [
    "Use spawn_subagent when delegated work is cheaper or better than doing it inline:",
    "research, code review, parallel analysis, or anything that would bloat your context.",
    "",
    "Two ways to spawn:",
    "  • Ad-hoc — pass `prompt` and (optionally) `tools`/`toolsets`/`model`. No",
    "    registration, no per-name memory. Right for one-off work.",
    "  • Named — pass `subagent: \"<name>\"` to use a definition you registered",
    "    via create_subagent. Named subagents have their own SOUL/USER/MEMORY",
    "    under .squad/subagents/<name>/ that survives across spawns.",
    "",
    "Use create_subagent to register a reusable subagent. It's live immediately —",
    "no restart — and persists across gateway restarts.",
    "",
    "Spawns are async by default — the tool returns a sessionId immediately and the",
    "subagent runs in the background. Pass `wait: true` only when you need the",
    "result inline before continuing.",
    "",
    "Subagents inherit the tree's task list. Put enough detail in the prompt (and",
    "any related task row) for the subagent to pick the work up cold.",
  ].join("\n"),
};
