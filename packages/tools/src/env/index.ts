import type { ToolGroup } from "../groups.js";

export type { EnvBackend } from "./backend.js";
export { SetEnvTool, UnsetEnvTool, ListEnvNamesTool, registerEnvTools } from "./tools.js";

/**
 * Default tool group — every session can read/write env vars on this
 * gateway. We mark it default (not lazy) because env management is
 * something the user might raise in any chat ("save my OPENAI_API_KEY",
 * "what env vars do I have set"), and unlocking a group adds a turn of
 * latency for no benefit.
 */
export const envGroup: ToolGroup = {
  name: "env",
  description: "Persist environment variables on this gateway (set/unset/list)",
  toolNames: ["set_env", "unset_env", "list_env_names"],
  guidance: [
    "Env management — anything the host's `process.env` exposes.",
    "",
    "Use `set_env` whenever the user gives you a value something on this",
    "host reads from `process.env` (API keys, tokens, db URLs, OAuth ids,",
    "etc.). It writes to a 0600 secrets file under `<data_dir>` AND injects",
    "into the running process's env so the next read picks it up — no",
    "restart, no `.env` editing by hand.",
    "",
    "Use `list_env_names` to check what's already stored before re-asking",
    "the user for a value. Values are never returned — only names.",
    "",
    "For *plugin* fields, prefer `plugin_install` with a `secrets` map.",
    "It hits the same store but also rolls back on install failure.",
  ].join("\n"),
  default: true,
};
