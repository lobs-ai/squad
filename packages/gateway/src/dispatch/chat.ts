import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import { runChatTurn, textBlocks } from "../runs.js";
import { ProtocolError, ErrorCode } from "@squad/protocol";

export interface ChatDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
  toolRegistry: ToolRegistry;
  defaultModel: string;
  /** Testing seam: inject a stub LLMClient to bypass real provider calls. */
  clientOverride?: LLMClient;
}

export function registerChatMethods(dispatcher: Dispatcher, deps: ChatDeps): void {
  dispatcher.register("chat.send", async (params) => {
    const session = deps.sessions.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    const content = textBlocks(params.content);
    const model = session.model || deps.defaultModel;
    const { userMessage, runId } = await runChatTurn(
      {
        sessionId: params.sessionId,
        userContent: content,
        model,
        toolRegistry: deps.toolRegistry,
        ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
      },
      deps,
    );
    return { message: userMessage, runId };
  });

  dispatcher.register("chat.history", async (params) => {
    const messages = deps.messages.listForSession(
      params.sessionId,
      params.limit,
      params.before,
    );
    return { messages };
  });
}
