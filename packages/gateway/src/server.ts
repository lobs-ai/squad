
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
import { registerSubagentMethods } from "./dispatch/subagents.js";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { ToolCallStore } from "./db/tool-calls.js";
import type { TaskStore } from "./tasks/store.js";
import type { QuestionStore } from "./questions/store.js";
import type { SubagentPool } from "./subagents/pool.js";
import type { SubagentRegistry } from "./subagents/registry.js";
import type { RunCoordinator } from "./delivery/coordinator.js";

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
  subagentPool: SubagentPool;
  subagentRegistry: SubagentRegistry;
  coordinator: RunCoordinator;
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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

function dashboardRoot(): string | null {
  // Resolve the dashboard dist relative to this file: gateway/dist → ../../dashboard/dist
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolvePath(here, "../../../dashboard/dist"),
    resolvePath(here, "../../../../packages/dashboard/dist"),
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return null;
}

const DASHBOARD_ROOT = dashboardRoot();

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stats = statSync(filePath);
  if (!stats.isFile()) return false;
  const ext = extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
  return true;
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
  // Dashboard static assets at / and /assets/*
  if (DASHBOARD_ROOT && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://host");
    const urlPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(DASHBOARD_ROOT, urlPath);
    // Prevent directory traversal.
    if (!filePath.startsWith(DASHBOARD_ROOT + sep) && filePath !== join(DASHBOARD_ROOT, "index.html")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (serveStatic(res, filePath)) return;
    // SPA fallback: serve index.html for unmatched routes.
    if (serveStatic(res, join(DASHBOARD_ROOT, "index.html"))) return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function buildDispatcher(deps: GatewayDeps): Dispatcher {
  const d = new Dispatcher();
  const primaryModel = deps.config.llm.primary.model;
  const fallbackModels = deps.config.llm.fallbacks.map((f) => f.model);
  registerSessionMethods(d, deps.sessions, {
    defaultModel: primaryModel,
    defaultFallbacks: fallbackModels,
  });
  registerChatMethods(d, {
    sessions: deps.sessions,
    messages: deps.messages,
    toolCalls: deps.toolCalls,
    broadcast: deps.broadcast,
    logger: deps.logger,
    toolRegistry: deps.toolRegistry,
    defaultModel: primaryModel,
    defaultFallbacks: fallbackModels,
    coordinator: deps.coordinator,
    ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
  });
  registerTaskMethods(d, deps.tasks, deps.broadcast);
  registerQuestionMethods(d, deps.questions);
  registerSubagentMethods(d, deps.subagentPool, deps.subagentRegistry, deps.sessions);
  registerAdminMethods(d, {
    sessions: deps.sessions,
    startedAt: deps.startedAt,
    version: deps.version,
    primaryModel,
    fallbackModels,
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
