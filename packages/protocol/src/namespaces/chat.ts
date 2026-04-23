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
export const chatSendResult = z.object({
  message: messageRecordSchema, // the user message that was accepted
  runId: z.string(),             // correlation id for the agent run this message triggered
});

// chat.history
export const chatHistoryParams = z.object({
  sessionId: z.string(),
  limit: z.number().int().positive().max(500).default(100),
  before: z.string().optional(),
});
export const chatHistoryResult = z.object({ messages: z.array(messageRecordSchema) });

export const chatMethods = {
  "chat.send": { params: chatSendParams, result: chatSendResult },
  "chat.history": { params: chatHistoryParams, result: chatHistoryResult },
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

export const chatEvents = {
  "chat.user_message": chatUserMessageEvent,
  "chat.assistant_message": chatAssistantMessageEvent,
  "chat.text_delta": chatTextDeltaEvent,
  "chat.tool_call": chatToolCallEvent,
  "chat.tool_result": chatToolResultEvent,
} as const;
