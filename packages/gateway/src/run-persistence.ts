import type { ContentBlock, MessageRecord } from "@squad/protocol";
import type { Session } from "@squad/runner";
import type { MessageStore } from "./db/messages.js";
import type { Broadcast } from "./broadcast.js";

/**
 * Convert wire ContentBlocks into the LLM's content shape for message
 * history. tool_result blocks need camelCase→snake_case remap (the
 * Anthropic wire format uses tool_use_id/is_error); text and tool_use
 * blocks pass through unchanged.
 */
export function toLLMContent(
  blocks: ContentBlock[],
): string | Array<Record<string, unknown>> {
  if (blocks.length === 1 && blocks[0]!.type === "text") return blocks[0]!.text;
  return blocks.map((b) => {
    if (b.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
    }
    return b as unknown as Record<string, unknown>;
  });
}

/**
 * Inverse of toLLMContent — fold runner/Anthropic-shaped content back into
 * wire ContentBlocks for persistence.
 */
export function llmToWireBlocks(
  content: string | Array<Record<string, unknown>>,
): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((b) => {
    if (b.type === "tool_result") {
      return {
        type: "tool_result" as const,
        toolUseId: b.tool_use_id as string,
        content: b.content as string | Array<unknown>,
        ...(b.is_error ? { isError: true } : {}),
      };
    }
    return b as unknown as ContentBlock;
  });
}

/**
 * Persist every message the runner produced this turn and broadcast the
 * final assistant message. Walks Session messages from `messageCountBefore`
 * onward — assistant turns (with their tool_use blocks intact) become
 * role:"assistant" rows and the runner's user-role tool-result messages
 * become role:"tool" rows so the dashboard can render them on refresh.
 * If the runner produced no assistant message, `fallbackText` is persisted
 * as a safety net so callers still see a reply.
 */
export function persistRunMessages(args: {
  messages: MessageStore;
  broadcast: Broadcast;
  sessionId: string;
  session: Session;
  messageCountBefore: number;
  runId: string;
  fallbackText: string;
}): MessageRecord {
  const newMessages = args.session._ref().slice(args.messageCountBefore);
  let finalAssistant: MessageRecord | null = null;
  for (const m of newMessages) {
    if (m.role === "assistant") {
      finalAssistant = args.messages.append({
        sessionId: args.sessionId,
        role: "assistant",
        content: llmToWireBlocks(m.content),
      });
    } else if (m.role === "user" && Array.isArray(m.content)) {
      const toolResults = m.content.filter(
        (b) => (b as { type?: string }).type === "tool_result",
      );
      if (toolResults.length === 0) continue;
      args.messages.append({
        sessionId: args.sessionId,
        role: "tool",
        content: llmToWireBlocks(toolResults),
      });
    }
  }
  if (!finalAssistant) {
    finalAssistant = args.messages.append({
      sessionId: args.sessionId,
      role: "assistant",
      content: [{ type: "text", text: args.fallbackText }],
    });
  }
  args.broadcast.publish(`chat.assistant_message/${args.sessionId}`, {
    sessionId: args.sessionId,
    message: finalAssistant,
    runId: args.runId,
  });
  return finalAssistant;
}
