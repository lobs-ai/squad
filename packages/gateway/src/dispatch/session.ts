import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";
import { ProtocolError, ErrorCode } from "@squad/protocol";

export interface SessionDispatchDeps {
  /** Default primary model when `session.start` is called without one. */
  defaultModel: string;
  /** Default fallback chain when `session.start` is called without one. */
  defaultFallbacks: string[];
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
    return { session: store.get(params.sessionId) };
  });

  dispatcher.register("session.list", async (params) => {
    const sessions = store.list({
      parentSessionId: params.parentSessionId ?? undefined,
      limit: params.limit,
    });
    return { sessions };
  });

  dispatcher.register("session.search", async () => {
    // Phase 3: stub. FTS5 UI lands in v1.1 per the roadmap; the index is
    // populated from day one so we can flip it on without a migration.
    return { hits: [] };
  });
}
