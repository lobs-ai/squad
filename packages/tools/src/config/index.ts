import type { ToolGroup } from "../groups.js";

export type { ConfigBackend, ConfigPath } from "./backend.js";
export { splitPath, flattenLeafPaths } from "./backend.js";
export {
  GetConfigTool,
  SetConfigTool,
  UnsetConfigTool,
  ListConfigPathsTool,
  registerConfigTools,
} from "./tools.js";

/** Lazy-loadable tool group for reading/writing the gateway's config.json. */
export const configGroup: ToolGroup = {
  name: "config",
  description: "Read and write the gateway's config.json (model, delivery mode, plugins, …)",
  toolNames: ["get_config", "set_config", "unset_config", "list_config_paths"],
  guidance: [
    "The config tools mutate the gateway's config.json. Treat that file as the source",
    "of truth for user preferences — don't hard-code assumptions you could read from it.",
    "",
    "- list_config_paths first if you don't know the shape; nested objects use dotted paths.",
    "- set_config validates writes; unset_config removes a path entirely.",
    "- Persist preferences (model, delivery mode, fallbacks, plugin list) here rather than",
    "  re-asking next session.",
  ].join("\n"),
};
