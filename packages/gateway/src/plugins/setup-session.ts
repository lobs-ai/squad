import type { SessionStore } from "../db/sessions.js";
import type { CatalogEntry } from "./catalog.js";

/**
 * Factory the dispatch layer calls when the user clicks "setup with agent"
 * on a catalog row. Encapsulated as an interface so dispatch/plugins.ts
 * doesn't need to know about session/message stores directly — also makes
 * tests easy to stub.
 */
export interface PluginSetupSessionFactory {
  create(args: {
    entry: CatalogEntry;
    /**
     * Pre-rendered describe payload — schema fields, secrets, currentConfig,
     * etc. Whatever `plugins.describe` would have returned. Embedded into
     * the seed message verbatim as a fenced JSON block so the agent has
     * the full picture without an extra tool call.
     */
    describePayload: Record<string, unknown>;
  }): { sessionId: string; seedMessage: string };
}

export interface PluginSetupSessionFactoryDeps {
  sessions: SessionStore;
  defaultModel: string;
}

/**
 * Default factory: creates a session titled "Setup: <plugin name>" and
 * returns the rendered seed message. The CALLER is responsible for sending
 * the seed text via `chat.send` from its own connection once it's
 * navigated to the chat view — that way:
 *
 *  - The user message streams through the same path a manually-typed
 *    message takes (no in-process dispatch shenanigans).
 *  - The dashboard / CLI is already subscribed to the session's events
 *    when the agent's response starts streaming, so nothing gets dropped.
 *  - Any error fires `chat.error` against the session the caller is now
 *    watching.
 */
export function buildPluginSetupSessionFactory(
  deps: PluginSetupSessionFactoryDeps,
): PluginSetupSessionFactory {
  return {
    create({ entry, describePayload }) {
      const session = deps.sessions.create({
        title: `Setup: ${entry.name}`,
        model: deps.defaultModel,
        fallbacks: [],
      });
      return {
        sessionId: session.id,
        seedMessage: renderSetupSeed(entry, describePayload),
      };
    },
  };
}

function renderSetupSeed(
  entry: CatalogEntry,
  describePayload: Record<string, unknown>,
): string {
  const lines: string[] = [
    `[setup-with-agent] The user wants help installing the "${entry.name}" plugin (catalog id: ${entry.id}).`,
    "",
    "## How this works",
    "",
    "Walk the user through the `setupPlaybook` (in the describe payload below). Paraphrase — don't dump it verbatim. Ask one question at a time.",
    "",
    "## Critical rules",
    "",
    "1. **Never claim you've done something until a tool returned a successful result.** Don't say \"stored ✅\", \"installed\", \"saved\", \"configured\", or \"done\" before you have the corresponding `tool_result` in this turn. The user has been burned by agents that report success based on intent rather than action — tool results are the only proof. If you haven't called the tool yet, say what you're about to do, then call it.",
    "",
    "2. **Don't ask the user where this gateway is running.** The `Runtime environment` section in your system prompt already tells you (docker / native, OS, data dir, workspace, the .env file path if there is one). Use those facts directly when explaining where things live.",
    "",
    "3. **Never tell the user to edit `.env` to set a plugin secret.** The install path has a built-in secret store. When you have a token or API key, call `plugin_install` with it in the `secrets` map:",
    "",
    "   ```json",
    "   { \"id\": \"" + entry.id + "\", \"config\": { …non-secret fields… }, \"secrets\": { \"DISCORD_BOT_TOKEN\": \"<the value the user pasted>\" } }",
    "   ```",
    "",
    "   The gateway writes that to a 0600 secrets file under `<data_dir>/secrets.json` and merges it into `process.env` so the plugin reads it normally — no restart, no env-file editing, no shell exports.",
    "",
    "4. **Collect every required field before calling install.** The describe payload's `fields` (typed config) and `secrets` (env-var-backed values) tell you exactly what's needed. `secrets[i].set === true` means the gateway already has that one — don't re-ask unless the user wants to rotate.",
    "",
    "5. **On `missing_config` / `missing_secret` errors:** the error tells you the field name. Ask the user for that specific value, then retry `plugin_install` with the value in `secrets` (for missing_secret) or `config` (for missing_config). If you'd rather set the env var first as a separate step (e.g. you want it stored even if install rolls back), call `set_env(name, value)` then re-run `plugin_install` — both write to the same secret store. **Never** tell the user to edit `.env`, export shell vars, or restart anything — those tools handle persistence and live injection.",
    "",
    "6. **Verify state by tool, not memory.** When the user says \"is X set up?\" or \"what's the current config?\", call `plugin_describe(id)` and read the returned `currentConfig` + `secrets[*].set` fields. Don't reconstruct state from earlier in the conversation — the tools are the source of truth. If you're not sure whether you ran an install successfully, run `plugin_describe` again and check.",
    "",
    "7. **After success:** confirm by asking the user to do whatever the plugin enables (e.g. \"send a test message in your bound guild channel and tell me if the bot replies\"). Don't claim victory until they confirm.",
    "",
    "## Describe payload",
    "```json",
    JSON.stringify(describePayload, null, 2),
    "```",
    "",
    "Now: greet the user briefly, summarize what the playbook will walk them through, and ask the first question.",
  ];
  return lines.join("\n");
}
