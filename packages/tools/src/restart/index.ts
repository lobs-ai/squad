import type { ToolGroup } from "../groups.js";

export type { RestartBackend, RestartScheduledResult } from "./backend.js";
export { RestartGatewayTool, registerRestartTool } from "./tools.js";

/** Lazy-loadable tool group for restarting the gateway. */
export const restartGroup: ToolGroup = {
  name: "restart",
  description:
    "Restart the gateway process — needed after edits to server.*, llm.providers.*, plugins, or auth.tokens",
  toolNames: ["restart_gateway"],
  guidance: [
    "Use restart_gateway only after a config edit (or plugin install/upgrade) that the",
    "set_config response flagged as restart-required. The agent's current session",
    "persists across restarts; chat resumes once the process comes back. The tool",
    "errors if the runtime has no supervisor or Docker restart policy — in that",
    "case ask the user to restart manually rather than retrying.",
  ].join("\n"),
};
