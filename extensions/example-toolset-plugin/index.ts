import { definePlugin } from "@squad/plugin-sdk";

/**
 * Example: a "research" toolset bundle plus a `researcher` subagent that
 * pulls it in by name. Drop the compiled JS into `extensions/` and point
 * `config.plugins` at this file. The toolset is also visible to other
 * subagents — register additional definitions with `toolsets: ["@squad/toolset-research"]`.
 */
export default definePlugin({
  id: "example-toolset",
  name: "Example toolset",
  version: "0.0.1",
  kinds: ["subagent"],
  register(api) {
    api.toolsets.register({
      name: "@squad/toolset-research",
      description:
        "Read-only research bundle: file inspection + task crud. Useful for any read/write-light subagent.",
      tools: ["read_file", "list_tasks", "create_task", "update_task"],
    });

    api.subagents.register({
      name: "researcher",
      description:
        "General-purpose researcher. Ships with the @squad/toolset-research bundle resolved at spawn.",
      model: "claude-sonnet-4-5",
      tools: [],
      toolsets: ["@squad/toolset-research"],
      systemPrompt: [
        "You are a meticulous researcher. Use the read-only file and task",
        "tools to gather facts. Report concrete findings; cite file:line.",
      ].join("\n"),
      limits: { maxTokens: 40_000, maxToolCalls: 50, timeoutMs: 120_000 },
    });
    api.logger.info("researcher subagent + research toolset registered");
  },
});
