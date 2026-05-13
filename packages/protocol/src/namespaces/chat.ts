import { z } from "zod";

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: z.string(), // base64
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
    isError: z.boolean().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const messageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  createdAt: z.string(),
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;

// chat.send
export const chatSendParams = z.object({
  sessionId: z.string(),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

/**
 * `status` tells the caller what happened to their message:
 * - `running`  — the message started a new agent run. `runId` is the run.
 * - `queued`   — a run was already in flight. The message was queued; it will
 *   be delivered according to the session's deliveryMode (interrupt =
 *   injected at the next LLM turn, queue = after the current run finishes).
 *   `runId` points at the **active** run; `queuePosition` tells the caller
 *   where they landed.
 */
export const chatSendResult = z.object({
  message: messageRecordSchema,
  runId: z.string(),
  status: z.enum(["running", "queued"]),
  queuePosition: z.number().int().nonnegative().optional(),
});

// chat.history
export const chatHistoryParams = z.object({
  sessionId: z.string(),
  limit: z.number().int().positive().max(500).default(100),
  before: z.string().optional(),
});
export const chatHistoryResult = z.object({ messages: z.array(messageRecordSchema) });

// chat.tool_calls — persisted tool-call audit trail for a session. The
// dashboard fetches this on session load to hydrate its in-memory liveTools
// after a refresh. Native models also persist tool_use blocks in their
// assistant messages, so those are deduplicated client-side by matching
// `llmToolUseId` against the `tool_use.id` in the message stream. For
// providers that run their own agent loop (claude-cli), this is the only
// place tool activity is recoverable post-refresh.
export const toolCallRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  name: z.string(),
  input: z.unknown(),
  result: z.unknown(),
  isError: z.boolean(),
  status: z.enum(["pending", "approved", "denied", "completed", "failed"]),
  createdAt: z.string(),
  llmToolUseId: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

export const chatToolCallsParams = z.object({
  sessionId: z.string(),
  limit: z.number().int().positive().max(1000).default(500),
});
export const chatToolCallsResult = z.object({
  toolCalls: z.array(toolCallRecordSchema),
});

// chat.cancel — request that the active run for `sessionId` stop at the next
// safe checkpoint (between LLM turns / tool batches). The agent loop honors
// the signal cooperatively; in-flight tool calls finish first.
export const chatCancelParams = z.object({
  sessionId: z.string(),
});
export const chatCancelResult = z.object({
  cancelled: z.boolean(),
  runId: z.string().optional(),
});

export const chatMethods = {
  "chat.send": { params: chatSendParams, result: chatSendResult },
  "chat.history": { params: chatHistoryParams, result: chatHistoryResult },
  "chat.tool_calls": { params: chatToolCallsParams, result: chatToolCallsResult },
  "chat.cancel": { params: chatCancelParams, result: chatCancelResult },
} as const;

// ── Events ────────────────────────────────────────────────────────────────────

export const chatUserMessageEvent = z.object({
  sessionId: z.string(),
  message: messageRecordSchema,
});
export const chatAssistantMessageEvent = z.object({
  sessionId: z.string(),
  message: messageRecordSchema,
  runId: z.string(),
});
export const chatTextDeltaEvent = z.object({
  sessionId: z.string(),
  runId: z.string(),
  delta: z.string(),
});
export const chatToolCallEvent = z.object({
  sessionId: z.string(),
  runId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export const chatToolResultEvent = z.object({
  sessionId: z.string(),
  runId: z.string(),
  toolCallId: z.string(),
  result: z.unknown(),
  isError: z.boolean().optional(),
});

export const chatErrorEvent = z.object({
  sessionId: z.string(),
  runId: z.string(),
  message: z.string(),
  /** Optional structured payload — e.g. provider, model, status code. */
  data: z.unknown().optional(),
});

export const chatEvents = {
  "chat.user_message": chatUserMessageEvent,
  "chat.assistant_message": chatAssistantMessageEvent,
  "chat.text_delta": chatTextDeltaEvent,
  "chat.tool_call": chatToolCallEvent,
  "chat.tool_result": chatToolResultEvent,
  "chat.error": chatErrorEvent,
} as const;
