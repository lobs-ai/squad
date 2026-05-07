import type { ToolGroup } from "../groups.js";

export type { AppBackend, RegisterAppRequest } from "./backend.js";
export {
  ExposeAppTool,
  UnexposeAppTool,
  ListAppsTool,
  registerAppTools,
} from "./tools.js";

/**
 * Lazy-loadable tool group. Agents discover the apps surface via
 * `describe_tool_group("apps")` and unlock it when they need to expose a
 * locally-running web app at `/apps/<name>/`.
 */
export const appsGroup: ToolGroup = {
  name: "apps",
  description:
    "Expose a child-process-hosted web app at /apps/<name>/ so it's reachable from the dashboard. Use after spawning a server with `exec`.",
  toolNames: ["expose_app", "unexpose_app", "list_apps"],
  guidance: [
    "Workflow: spawn a server with `exec` on a free localhost port, then call",
    "`expose_app({name, title, port})`. Apps built with the @squad/app-sdk",
    "auto-mount /squad/info and /squad/health for the gateway's prober.",
    "Pass scope:'session' to have the registration cleaned up automatically",
    "when the chat session ends; otherwise it persists.",
  ].join("\n"),
};
