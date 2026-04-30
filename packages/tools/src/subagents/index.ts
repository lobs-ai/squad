import type { ToolGroup } from "../groups.js";

export type { SubagentBackend } from "./backend.js";
export { SpawnSubagentTool, registerSpawnSubagentTool } from "./tools.js";

/** Lazy-loadable tool group for spawning subagents. */
export const subagentsGroup: ToolGroup = {
  name: "subagents",
  description:
    "Spawn a named, reusable subagent (own model/tools/prompt) — for delegated or parallelizable work",
  toolNames: ["spawn_subagent"],
  guidance: [
    "Use spawn_subagent when delegated work is cheaper or better than doing it inline:",
    "research, code review, parallel analysis, or anything that would bloat your context.",
    "",
    "Pass `wait: true` to get the result inline. Pass `wait: false` (default) to fan out —",
    "the tool returns a sessionId immediately and the subagent streams on its own topic.",
    "",
    "Subagents inherit the tree's task list. Put enough detail in the spawn input (and",
    "any related task row) for the subagent to pick the work up cold.",
  ].join("\n"),
};
