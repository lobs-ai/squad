import { randomUUID } from "node:crypto";
import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";
import { ToolRegistry, type ToolGroupRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import { runChatTurn, textBlocks } from "../runs.js";
import type { RunCoordinator } from "../delivery/coordinator.js";
import type { MemoryService } from "../memory/service.js";
import type { TitleGenerator } from "../title-generator.js";
import { ProtocolError, ErrorCode, type ContentBlock, type MessageRecord } from "@squad/protocol";

export interface ChatDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
  toolRegistry: ToolRegistry;
  /**
   * Lazy tool-group registry. When set, runChatTurn computes the per-turn
   * allow-list from the default groups + the session's unlocked groups.
   */
  toolGroups?: ToolGroupRegistry;
  defaultModel: string;
  defaultFallbacks: string[];
  coordinator: RunCoordinator;
  /** Persistent agent home directory. Used as cwd for every chat turn. */
  workspaceDir: string;
  /** Optional memory subsystem; when set, injects eager + retrieval blocks. */
  memory?: MemoryService;
  /**
   * When set, every chat.send fires the auto-titler after the first user
   * message of an untitled session. Skipped silently when undefined (which
   * is what happens when `chat.auto_title` is false).
   */
  titleGenerator?: TitleGenerator;
  /** Testing seam: inject a stub LLMClient to bypass real provider calls. */
  clientOverride?: LLMClient;
  /** Trace registry — wired by boot, optional in tests. */
  traceRegistry?: import("../traces.js").TraceSessionRegistry;
  /**
   * Pre-rendered runtime-environment section. Forwarded to runChatTurn so
   * every turn's system prompt includes a "where am I running" briefing.
   */
  runtimeEnvSection?: string;
  /** Live PromptContext store; forwarded to runChatTurn. */
  promptContextStore?: import("@squad/tools").PromptContextStore;
  /** Per-session RenderContext factory; forwarded to runChatTurn. */
  renderContextFor?: (sessionId: string) => import("@squad/tools").RenderContext;
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
    // Fallbacks are pinned at session creation (see session.start). New
    // sessions created via channels that don't know about the chain fall
    // back to the gateway default so every session still gets resilience.
    const fallbacks = session.fallbacks.length > 0 ? session.fallbacks : deps.defaultFallbacks;
    return new Promise<MessageRecord | null>((resolve, reject) => {
      let resolved = false;
      const run = runChatTurn(
        {
          sessionId,
          runId,
          userContent: content,
          persistUserMessage: opts.persistUserMessage,
          model,
          fallbacks,
          toolRegistry: deps.toolRegistry,
          ...(deps.toolGroups ? { toolGroups: deps.toolGroups } : {}),
          cwd: deps.workspaceDir,
          onUserMessagePersisted: (msg) => {
            resolved = true;
            resolve(msg);
          },
          onRunStart: (ctx) => deps.coordinator.register(ctx.runId, ctx.sessionId, ctx.session),
          onRunEnd: (ctx) => deps.coordinator.finish(ctx.runId, ctx.sessionId),
          shouldCancel: () => deps.coordinator.isCancelled(runId),
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
      maybeAutoTitle(deps, params.sessionId, content);
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
    maybeAutoTitle(deps, params.sessionId, content);

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

  dispatcher.register("chat.tool_calls", async (params) => {
    const toolCalls = deps.toolCalls.listForSession(params.sessionId, params.limit);
    return { toolCalls };
  });

  dispatcher.register("chat.cancel", async (params) => {
    const session = deps.sessions.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    const runId = deps.coordinator.cancel(params.sessionId);
    if (runId === null) {
      return { cancelled: false };
    }
    return { cancelled: true, runId };
  });
}

/**
 * Best-effort: kick off a title-generation pass for a session that doesn't
 * have a real title yet. Runs in the background — caller never awaits.
 *
 * Bailing out cheaply (no titler wired, session already named, message is
 * empty) keeps this safe to call on every chat.send without paying the LLM
 * round-trip. The titler's own `needsTitle` re-checks before persisting.
 */
function maybeAutoTitle(deps: ChatDeps, sessionId: string, content: ContentBlock[]): void {
  const titler = deps.titleGenerator;
  if (!titler) {
    deps.logger.debug({ sessionId }, "auto-title: skipped — no title generator wired");
    return;
  }
  const session = deps.sessions.tryGet(sessionId);
  if (!session) return;
  if (!titler.needsTitle(session.title)) return;
  // Subagent transcripts get titled by their parent's reply; don't burn an
  // LLM call on every spawn.
  if (session.parentSessionId) {
    deps.logger.debug(
      { sessionId, parentSessionId: session.parentSessionId },
      "auto-title: skipped — subagent session, parent will title",
    );
    return;
  }
  const text = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    deps.logger.debug(
      { sessionId },
      "auto-title: skipped — first user message has no text content",
    );
    return;
  }
  deps.logger.debug({ sessionId, seedChars: text.length }, "auto-title: dispatching");
  void titler.generateIfNeeded(sessionId, text).catch((err) => {
    deps.logger.warn({ err, sessionId }, "auto-title fire-and-forget failed");
  });
}
