import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { Logger } from "./logger.js";
import type { Authenticator } from "./auth.js";
import type { Broadcast } from "./broadcast.js";
import { Dispatcher } from "./dispatch/index.js";
import { attach } from "./wire.js";
import type { Config } from "./config.js";
import { registerSessionMethods } from "./dispatch/session.js";
import { registerChatMethods } from "./dispatch/chat.js";
import { registerAdminMethods } from "./dispatch/admin.js";
import { registerTaskMethods } from "./dispatch/tasks.js";
import { registerQuestionMethods } from "./dispatch/questions.js";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { ToolCallStore } from "./db/tool-calls.js";
import type { TaskStore } from "./tasks/store.js";
import type { QuestionStore } from "./questions/store.js";

export interface GatewayDeps {
  config: Config;
  logger: Logger;
  authenticator: Authenticator;
  broadcast: Broadcast;
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  tasks: TaskStore;
  questions: QuestionStore;
  toolRegistry: ToolRegistry;
  startedAt: number;
  version: string;
  /** Testing seam: inject an LLMClient to bypass real provider calls. */
  clientOverride?: LLMClient;
}

export interface GatewayHandle {
  http: HttpServer;
  wss: WebSocketServer;
  dispatcher: Dispatcher;
  close: () => Promise<void>;
}

export function createGatewayServer(deps: GatewayDeps): GatewayHandle {
  const dispatcher = buildDispatcher(deps);

  const http = createServer((req, res) => handleHttp(req, res, deps));
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = extractToken(req, url);
    const grant = deps.authenticator.verify(token);
    if (!grant) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      attach(ws, grant, {
        dispatcher,
        authenticator: deps.authenticator,
        broadcast: deps.broadcast,
        logger: deps.logger,
      });
      deps.logger.info({ label: grant.label }, "ws connected");
    });
  });

  return {
    http,
    wss,
    dispatcher,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const q = url.searchParams.get("token");
  if (q) return q;
  return undefined;
}

function handleHttp(req: IncomingMessage, res: ServerResponse, deps: GatewayDeps): void {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        version: deps.version,
        uptimeSeconds: (Date.now() - deps.startedAt) / 1000,
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function buildDispatcher(deps: GatewayDeps): Dispatcher {
  const d = new Dispatcher();
  registerSessionMethods(d, deps.sessions, deps.config.llm.default_model);
  registerChatMethods(d, {
    sessions: deps.sessions,
    messages: deps.messages,
    toolCalls: deps.toolCalls,
    broadcast: deps.broadcast,
    logger: deps.logger,
    toolRegistry: deps.toolRegistry,
    defaultModel: deps.config.llm.default_model,
    ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
  });
  registerTaskMethods(d, deps.tasks, deps.broadcast);
  registerQuestionMethods(d, deps.questions);
  registerAdminMethods(d, {
    sessions: deps.sessions,
    startedAt: deps.startedAt,
    version: deps.version,
    defaultModel: deps.config.llm.default_model,
    providers: Object.keys(deps.config.llm.providers),
    subagents: {
      maxConcurrentGlobal: deps.config.subagents.max_concurrent_global,
      maxConcurrentPerParent: deps.config.subagents.max_concurrent_per_parent,
      maxTreeDepth: deps.config.subagents.max_tree_depth,
    },
    approvals: {
      requireForTags: deps.config.policy.approvals.require_for_tags,
      timeoutSeconds: deps.config.policy.approvals.timeout_seconds,
    },
  });
  return d;
}
