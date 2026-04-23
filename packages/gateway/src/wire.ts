import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  parseFrameString,
  ProtocolError,
  ErrorCode,
  type Frame,
  type EventFrame,
  type ResponseFrame,
} from "@squad/protocol";
import type { Dispatcher } from "./dispatch/index.js";
import type { Authenticator, TokenGrant } from "./auth.js";
import type { Broadcast, Subscriber } from "./broadcast.js";
import type { Logger } from "./logger.js";

export interface ConnectionDeps {
  dispatcher: Dispatcher;
  authenticator: Authenticator;
  broadcast: Broadcast;
  logger: Logger;
}

/**
 * Handle one authenticated WebSocket connection. The caller is responsible
 * for authentication before calling `attach` — the token check happens in
 * the HTTP upgrade handler.
 */
export function attach(ws: WebSocket, grant: TokenGrant, deps: ConnectionDeps): void {
  const subscriberId = randomUUID();
  const subscriber: Subscriber = {
    id: subscriberId,
    send: (frame: EventFrame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    },
  };

  ws.on("message", async (raw) => {
    let frame: Frame;
    try {
      frame = parseFrameString(raw.toString("utf8"));
    } catch (err) {
      if (err instanceof ProtocolError) {
        sendResponse(ws, {
          type: "response",
          id: "unknown",
          ok: false,
          error: err.toEnvelope(),
        });
      }
      return;
    }

    if (frame.type === "request") {
      try {
        const result = await deps.dispatcher.dispatch(frame.method, frame.params, {
          grant,
          authenticator: deps.authenticator,
          subscriberId,
        });
        sendResponse(ws, { type: "response", id: frame.id, ok: true, result });
      } catch (err) {
        const envelope =
          err instanceof ProtocolError
            ? err.toEnvelope()
            : {
                code: ErrorCode.internal_error,
                message: err instanceof Error ? err.message : String(err),
              };
        deps.logger.error({ err, method: frame.method }, "dispatch error");
        sendResponse(ws, { type: "response", id: frame.id, ok: false, error: envelope });
      }
      return;
    }

    if (frame.type === "subscribe") {
      for (const topic of frame.topics) deps.broadcast.subscribe(subscriber, topic);
      sendResponse(ws, {
        type: "response",
        id: frame.id,
        ok: true,
        result: { topics: frame.topics },
      });
      return;
    }

    if (frame.type === "unsubscribe") {
      for (const topic of frame.topics) deps.broadcast.unsubscribe(subscriber, topic);
      sendResponse(ws, {
        type: "response",
        id: frame.id,
        ok: true,
        result: { topics: frame.topics },
      });
      return;
    }

    // Clients should not send `response` or `event` frames. Ignore them.
  });

  ws.on("close", () => {
    deps.broadcast.removeAll(subscriber);
  });
}

function sendResponse(ws: WebSocket, frame: ResponseFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}
