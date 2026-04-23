import { runAgent, Session } from "@squad/runner";
import type { AgentSpec, AgentResult } from "@squad/runner";
import type { ContentBlock as LLMContentBlock } from "@squad/llm";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { ContentBlock, MessageRecord } from "@squad/protocol";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { ToolCallStore } from "./db/tool-calls.js";
import type { Broadcast } from "./broadcast.js";
import type { Logger } from "./logger.js";

/**
 * Convert wire ContentBlocks into the LLM's content shape for message
 * history. For Phase 3 we accept text blocks only; richer types roll in
 * with the ask-user/subagent phases.
 */
function toLLMContent(blocks: ContentBlock[]): string | Array<Record<string, unknown>> {
  if (blocks.length === 1 && blocks[0]!.type === "text") return blocks[0]!.text;
  return blocks.map((b) => b as unknown as Record<string, unknown>);
}

function textBlocks(content: ContentBlock[] | string): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export interface RunOptions {
  sessionId: string;
  /**
   * Correlation id for this run. The delivery coordinator generates this
   * before start() fires so it can register hooks keyed on the same id the
   * runner sees via `context.taskId`.
   */
  runId: string;
  /**
   * Content the turn starts with. May be empty for queue-mode follow-on
   * turns that consume an existing user message from history.
   */
  userContent: ContentBlock[];
  /**
   * When true, persist `userContent` as a new user message and broadcast it.
   * Set to false when the caller already wrote the user message (e.g., when
   * a queued message's row was persisted at enqueue time).
   */
  persistUserMessage: boolean;
  model: string;
  systemPrompt?: string;
  toolRegistry: ToolRegistry;
  clientOverride?: LLMClient;
  /** Fires once the user message row has been written to SQLite. */
  onUserMessagePersisted?: (msg: MessageRecord) => void;
  /**
   * Hook the coordinator uses to register the active run *before* the agent
   * loop starts calling hooks. Returning the Session lets the coordinator
   * mutate history mid-run for interrupt mode.
   */
  onRunStart?: (ctx: { runId: string; sessionId: string; session: Session }) => void;
  onRunEnd?: (ctx: { runId: string; sessionId: string }) => Promise<void> | void;
}

export interface RunDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
}

/**
 * Persist the user message, start an agent run, stream deltas through
 * the broadcast bus, and persist the assistant message on completion.
 *
 * Phase 3 scope: text in, text out, tools optional. Tool-call events
 * publish to `chat.tool_call` / `chat.tool_result` but the tool registry
 * is empty unless the caller supplies one.
 */
export async function runChatTurn(
  options: RunOptions,
  deps: RunDeps,
): Promise<{ userMessage: MessageRecord | null; runId: string; result: AgentResult }> {
  const runId = options.runId;
  let userMessage: MessageRecord | null = null;
  if (options.persistUserMessage) {
    userMessage = deps.messages.append({
      sessionId: options.sessionId,
      role: "user",
      content: options.userContent,
    });
    deps.broadcast.publish(`chat.user_message/${options.sessionId}`, {
      sessionId: options.sessionId,
      message: userMessage,
    });
    options.onUserMessagePersisted?.(userMessage);
  }

  // Pull the full session history and feed it to the runner.
  const history = deps.messages.listForSession(options.sessionId, 1000);
  const runnerMessages = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: toLLMContent(m.content),
    }));

  deps.sessions.setStatus(options.sessionId, "running");

  const session = new Session(runnerMessages);
  options.onRunStart?.({ runId, sessionId: options.sessionId, session });

  const spec: AgentSpec = {
    task:
      options.userContent
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n") || "",
    agent: "default",
    model: options.model,
    cwd: process.cwd(),
    tools: options.toolRegistry.names(),
    toolRegistry: options.toolRegistry,
    timeout: { total: 300 },
    session,
    // taskId must equal runId so the before_llm_call hook can correlate.
    context: { sessionId: options.sessionId, taskId: runId },
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.clientOverride !== undefined ? { clientOverride: options.clientOverride } : {}),
    onTextChunk: (delta) => {
      deps.broadcast.publish(`chat.text_delta/${options.sessionId}`, {
        sessionId: options.sessionId,
        runId,
        delta,
      });
    },
    onProgress: (update) => {
      if (update.type === "tool_start" && update.toolName) {
        const record = deps.toolCalls.begin({
          sessionId: options.sessionId,
          runId,
          name: update.toolName,
          input: update.toolInput ?? {},
        });
        deps.broadcast.publish(`chat.tool_call/${options.sessionId}`, {
          sessionId: options.sessionId,
          runId,
          toolCallId: record.id,
          name: update.toolName,
          input: update.toolInput ?? {},
        });
      } else if (update.type === "tool_result" && update.toolName) {
        deps.broadcast.publish(`chat.tool_result/${options.sessionId}`, {
          sessionId: options.sessionId,
          runId,
          toolCallId: update.toolName,
          result: update.result,
        });
      }
    },
  };

  let result: AgentResult;
  try {
    result = await runAgent(spec);
  } finally {
    deps.sessions.setStatus(options.sessionId, "idle");
    await options.onRunEnd?.({ runId, sessionId: options.sessionId });
  }

  deps.sessions.addTokens(
    options.sessionId,
    result.usage.inputTokens,
    result.usage.outputTokens,
  );

  // The final assistant message is whatever Session accumulated last.
  const finalMessages = session._ref();
  const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");

  const assistantBlocks: ContentBlock[] = lastAssistant
    ? toWireBlocks(lastAssistant.content)
    : [{ type: "text", text: result.output }];

  const assistantMessage = deps.messages.append({
    sessionId: options.sessionId,
    role: "assistant",
    content: assistantBlocks,
  });

  deps.broadcast.publish(`chat.assistant_message/${options.sessionId}`, {
    sessionId: options.sessionId,
    message: assistantMessage,
    runId,
  });

  return { userMessage, runId, result };
}

function toWireBlocks(content: string | Array<Record<string, unknown>>): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((b) => b as unknown as LLMContentBlock as unknown as ContentBlock);
}

// Re-export textBlocks for the chat dispatcher to normalize input.
export { textBlocks };
