import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { SessionIngestionService } from "../memory/session-ingest.js";
import { ProtocolError, ErrorCode } from "@squad/protocol";
import { listAvailableModels } from "@squad/llm";

export interface SessionDispatchDeps {
  /** Default primary model when `session.start` is called without one. */
  defaultModel: string;
  /** Default fallback chain when `session.start` is called without one. */
  defaultFallbacks: string[];
  /** Message store for /stats + /compact context metrics. */
  messages: MessageStore;
  /** Tool call store for /stats tool-call count. */
  toolCalls: ToolCallStore;
  /**
   * When set, `session.end` enqueues an immediate ingestion pass for any
   * unprocessed delta. Optional — tests and headless deployments leave it
   * undefined and rely solely on the idle sweeper (or skip ingestion
   * entirely).
   */
  ingestion?: SessionIngestionService;
  /**
   * When set, subagent sessions get `ingestable=false` at create time so
   * the sweeper skips them. Mirrors `memcore.ingest.include_subagents`.
   */
  skipSubagentIngestion?: boolean;
}

export function registerSessionMethods(
  dispatcher: Dispatcher,
  store: SessionStore,
  deps: SessionDispatchDeps,
): void {
  dispatcher.register("session.start", async (params) => {
    const session = store.create({
      ...(params.title !== undefined ? { title: params.title } : {}),
      model: params.model ?? deps.defaultModel,
      // Callers can pin a session to a specific model with `fallbacks: []` to
      // opt out of the gateway-configured chain. `undefined` inherits the
      // gateway default.
      fallbacks: params.fallbacks ?? deps.defaultFallbacks,
      ...(params.platform !== undefined ? { platform: params.platform } : {}),
      ...(params.remoteId !== undefined ? { remoteId: params.remoteId } : {}),
      ...(params.deliveryMode !== undefined ? { deliveryMode: params.deliveryMode } : {}),
    });
    // Subagent sessions are excluded from memory ingestion by default — the
    // parent's transcript already captures what mattered. Toggle via
    // memcore.ingest.include_subagents.
    if (deps.skipSubagentIngestion && session.parentSessionId) {
      store.setIngestable(session.id, false);
    }
    return { session };
  });

  dispatcher.register("session.resume", async (params) => {
    const session = store.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    return { session };
  });

  dispatcher.register("session.end", async (params) => {
    const session = store.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    store.setStatus(params.sessionId, "ended");
    // Fire-and-forget ingestion. session.end RPCs need to stay cheap, so we
    // don't await — the ingestion service handles its own logging and retry.
    if (deps.ingestion) {
      void deps.ingestion.ingestNow(params.sessionId);
    }
    return { session: store.get(params.sessionId) };
  });

  dispatcher.register("session.list", async (params) => {
    const sessions = store.list({
      parentSessionId: params.parentSessionId ?? undefined,
      limit: params.limit,
    });
    return { sessions };
  });

  dispatcher.register("session.search", async (params) => {
    const hits = deps.messages.search({
      query: params.query,
      limit: params.limit,
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    });
    // Resolve each hit's session record once, in batch, so the response
    // carries the structured metadata that older clients rely on.
    const sessionIds = Array.from(new Set(hits.map((h) => h.sessionId)));
    const sessionRecs = new Map(
      sessionIds.map((id) => [id, store.tryGet(id)] as const),
    );
    const enriched = hits.flatMap((h) => {
      const rec = sessionRecs.get(h.sessionId);
      if (!rec) return [];
      return [{
        session: rec,
        sessionId: h.sessionId,
        messageId: h.messageId,
        snippet: h.snippet,
        ts: h.ts,
        score: h.score,
      }];
    });
    return { hits: enriched };
  });

  dispatcher.register("session.rename", async (params) => {
    if (!store.tryGet(params.sessionId)) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    store.setTitle(params.sessionId, params.title);
    return { session: store.get(params.sessionId) };
  });

  dispatcher.register("session.setModel", async (params) => {
    if (!store.tryGet(params.sessionId)) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    // No catalogue validation here: users can configure custom providers with
    // model ids outside the built-in catalog. If the id is wrong, the next
    // chat.send will fail with a clear provider-level error.
    store.setModel(params.sessionId, params.model, params.fallbacks);
    return { session: store.get(params.sessionId) };
  });

  dispatcher.register("session.setTitleModel", async (params) => {
    if (!store.tryGet(params.sessionId)) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    store.setTitleModel(params.sessionId, params.titleModel);
    return { session: store.get(params.sessionId) };
  });

  dispatcher.register("session.stats", async (params) => {
    const session = store.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    const messageCount = deps.messages.countForSession(params.sessionId);
    const turnCount = deps.toolCalls.countDistinctRunsForSession(params.sessionId);
    const toolCallCount = deps.toolCalls.countForSession(params.sessionId);
    const estimatedTokens = deps.messages.estimateTokensForSession(params.sessionId);
    // Look up context window for the session's current model.
    const all = listAvailableModels([]);
    const modelInfo = all.find((m) => m.id === session.model);
    const contextWindow = modelInfo?.contextWindow ?? null;
    const contextFillPct =
      contextWindow && contextWindow > 0
        ? Math.min(100, (estimatedTokens / contextWindow) * 100)
        : null;
    return {
      session,
      messageCount,
      turnCount,
      toolCallCount,
      estimatedTokens,
      contextWindow,
      contextFillPct,
    };
  });

  dispatcher.register("session.compact", async (params) => {
    const session = store.tryGet(params.sessionId);
    if (!session) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    const beforeMessageCount = deps.messages.countForSession(params.sessionId);
    const beforeEstimatedTokens = deps.messages.estimateTokensForSession(params.sessionId);
    store.setCompactAtStart(params.sessionId, true);
    return {
      session: store.get(params.sessionId),
      queued: true,
      beforeMessageCount,
      beforeEstimatedTokens,
    };
  });
}
