import { definePlugin } from "@squad/plugin-sdk";

/**
 * Minimal example plugin that registers a `code-reviewer` subagent. Drop the
 * compiled JS into `extensions/` and point `config.plugins` at this file.
 */
export default definePlugin({
  id: "example-subagent",
  name: "Example subagent",
  version: "0.0.1",
  kinds: ["subagent"],
  register(api) {
    api.subagents.register({
      name: "code-reviewer",
      description: "Read-only review of a diff with file:line callouts.",
      model: "claude-sonnet-4-5",
      tools: ["read_file", "list_tasks", "create_task", "update_task"],
      systemPrompt: [
        "You are a careful code reviewer. Read-only tools only.",
        "Report concrete issues with file:line. Skip style nits.",
      ].join("\n"),
      limits: { maxTokens: 40_000, maxToolCalls: 50, timeoutMs: 120_000 },
    });
    api.logger.info("code-reviewer subagent registered");
  },
});
