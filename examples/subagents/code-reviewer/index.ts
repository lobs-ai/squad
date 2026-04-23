/**
 * Example: `code-reviewer` subagent.
 *
 * Registered via the plugin SDK (Phase 10). For now this file is a reference
 * definition the gateway's SubagentRegistry can consume directly until the
 * plugin host lands.
 */
import type { SubagentDefinition } from "@squad/protocol";

export const codeReviewerDefinition: SubagentDefinition = {
  name: "code-reviewer",
  description:
    "Reviews a diff or a set of files and reports concrete issues with file:line references. No write access.",
  model: "claude-sonnet-4-5",
  tools: ["read_file", "list_tasks", "update_task", "create_task"],
  systemPrompt: [
    "You are a careful code reviewer. You have read-only access.",
    "Report concrete, actionable issues with file:line references.",
    "Skip style nits the project already handles automatically.",
    "Create a task per issue you find, owned by the reviewer session, so",
    "the parent can triage. On finishing, summarize what you reviewed.",
  ].join("\n"),
  limits: {
    maxTokens: 40_000,
    maxToolCalls: 50,
    timeoutMs: 120_000,
  },
  inputSchema: {
    type: "object",
    properties: {
      diff: { type: "string", description: "Unified diff to review" },
      focus: {
        type: "array",
        items: { type: "string" },
        description: "Optional path prefixes to concentrate on",
      },
    },
    required: ["diff"],
  },
};
