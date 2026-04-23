import { randomUUID } from "node:crypto";
import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import { runChatTurn, textBlocks } from "../runs.js";
import type { RunCoordinator } from "../delivery/coordinator.js";
import { ProtocolError, ErrorCode, type ContentBlock, type MessageRecord } from "@squad/protocol";

export interface ChatDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
  toolRegistry: ToolRegistry;
  defaultModel: string;
  coordinator: RunCoordinator;
  /** Testing seam: inject a stub LLMClient to bypass real provider calls. */
  clientOverride?: LLMClient;
}

export function registerChatMethods(dispatcher: Dispatcher, deps: ChatDeps): void {
  /**
   * Start a turn. Persists the user message synchronously via the
   * `onUserMessagePersisted` callback so the caller can return the
   * MessageRecord before runAgent returns; the run itself proceeds in the
   * background.
   */
  const startTurn = (
    sessionId: string,
    content: ContentBlock[],
    runId: string,
    opts: { persistUserMessage: boolean },
  ): Promise<MessageRecord | null> => {
    const session = deps.sessions.get(sessionId);
    const model = session.model || deps.defaultModel;
    return new Promise<MessageRecord | null>((resolve, reject) => {
      let resolved = false;
      const run = runChatTurn(
        {
          sessionId,
          runId,
          userContent: content,
          persistUserMessage: opts.persistUserMessage,
          model,
          toolRegistry: deps.toolRegistry,
          onUserMessagePersisted: (msg) => {
            resolved = true;
            resolve(msg);
          },
          onRunStart: (ctx) => deps.coordinator.register(ctx.runId, ctx.sessionId, ctx.session),
          onRunEnd: (ctx) => deps.coordinator.finish(ctx.runId, ctx.sessionId),
          ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
        },
        deps,
      );
      // When we're not persisting a user message there's no early
      // resolution point — resolve once runChatTurn has registered the run.
      if (!opts.persistUserMessage) {
        queueMicrotask(() => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });
      }
      run.catch((err) => {
        deps.logger.error({ err, sessionId }, "chat run failed");
        if (!resolved) reject(err);
      });
    });
  };

  // Let the coordinator initiate follow-on turns through the same path.
  deps.coordinator.setStarter(async (sessionId, content, opts) => {
    await startTurn(sessionId, content, randomUUID(), opts);
  });

  dispatcher.register("chat.send", async (params) => {
    const session = deps.sessions.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    const content = textBlocks(params.content);
    const proposedRunId = randomUUID();

    const decision = deps.coordinator.decide(params.sessionId, content, proposedRunId);

    if (decision.status === "running") {
      const userMessage = await startTurn(params.sessionId, content, decision.runId, {
        persistUserMessage: true,
      });
      if (!userMessage) {
        throw new ProtocolError(
          ErrorCode.internal_error,
          "run started without a persisted user message",
        );
      }
      return {
        message: userMessage,
        runId: decision.runId,
        status: "running" as const,
      };
    }

    // Queued: persist the user message row ourselves so clients see it in
    // history right away, and broadcast it. The coordinator already captured
    // the content for delivery; the row is a UI-facing receipt.
    const userMessage = deps.messages.append({
      sessionId: params.sessionId,
      role: "user",
      content,
    });
    deps.broadcast.publish(`chat.user_message/${params.sessionId}`, {
      sessionId: params.sessionId,
      message: userMessage,
    });

    return {
      message: userMessage,
      runId: decision.runId,
      status: "queued" as const,
      ...(decision.queuePosition !== undefined ? { queuePosition: decision.queuePosition } : {}),
    };
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
