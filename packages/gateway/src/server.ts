
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ToolRegistry, type ConfigBackend, type ToolGroupRegistry } from "@squad/tools";
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
import { registerApprovalMethods } from "./dispatch/approvals.js";
import { registerPluginMethods } from "./dispatch/plugins.js";
import { registerChannelMethods } from "./dispatch/channels.js";
import { registerRoutineMethods } from "./dispatch/routines.js";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { ToolCallStore } from "./db/tool-calls.js";
import type { TaskStore } from "./tasks/store.js";
import type { QuestionStore } from "./questions/store.js";
import type { SubagentPool } from "./subagents/pool.js";
import type { SubagentRegistry } from "./subagents/registry.js";
import type { SubagentDefStore } from "./db/subagent-defs.js";
import type { RunCoordinator } from "./delivery/coordinator.js";
import type { MemoryService } from "./memory/service.js";
import type { SessionIngestionService } from "./memory/session-ingest.js";
import type { ApprovalStore } from "./approvals/store.js";
import type { ApprovalRuleStore } from "./approvals/rules.js";
import type { PluginHost } from "./plugins/host.js";
import type { ChannelRegistry } from "./channels/registry.js";
import type { RoutineStore, RoutineRunner } from "./routines/store.js";
import type { CronPaths } from "./routines/persistence.js";
import { PeerSource } from "./peers/source.js";
import type { PairingStore } from "./auth/pairing.js";
import type { CommandRegistry } from "./commands/registry.js";
import type { ToolsetRegistry } from "./toolsets/registry.js";
import { registerCommandMethods } from "./dispatch/commands.js";
import { registerToolsetMethods } from "./dispatch/toolsets.js";
import type { HttpApiHandler } from "./http-api.js";
import { createHmac, timingSafeEqual } from "node:crypto";

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
  /** Optional persistence for user-created subagent definitions. */
  subagentDefStore?: SubagentDefStore;
  coordinator: RunCoordinator;
  toolRegistry: ToolRegistry;
  /** Tool-group registry; runChatTurn uses it for per-turn lazy loading. */
  toolGroups?: ToolGroupRegistry;
  /** Persistent agent home directory; used as cwd for chat turns. */
  workspaceDir: string;
  /** Memory subsystem — eager + retrieval blocks injected per turn. */
  memory?: MemoryService;
  /**
   * Idle-driven session ingestion. When set, `session.end` triggers an
   * immediate ingestion pass; otherwise sessions only ingest via the
   * sweeper. Tests/ephemeral deployments leave this undefined.
   */
  sessionIngestion?: SessionIngestionService;
  /** Mirrors `memcore.ingest.include_subagents`. */
  ingestSubagents?: boolean;
  startedAt: number;
  version: string;
  /** Approval prompts state — pending + decided history for `approvals.list/decide`. */
  approvals?: ApprovalStore;
  /** Persistent allow-list rules powering `approvals.allow_path`. */
  approvalRules?: ApprovalRuleStore;
  /** Plugin registry — surfaces `plugins.list/enable/disable/reload/configure`. */
  plugins?: PluginHost;
  /** Channel registry — surfaces `channels.list/bind/unbind/capabilities`. */
  channels?: ChannelRegistry;
  /** Routine record store — surfaces `routines.list/create/update/delete/run_now`. */
  routineStore?: RoutineStore;
  /** Runner used by `routines.run_now`. */
  routineRunner?: RoutineRunner;
  /** Cron filesystem paths — required to expose `routines.runs` / `routines.tail`. */
  cronPaths?: CronPaths;
  /** Peer enumeration source for `admin.peers`. */
  peers?: PeerSource;
  /** Browser pairing store, powering `/pair/*` HTTP + `admin.pair.*` dispatch. */
  pairing?: PairingStore;
  /** Slash command catalog — surfaces `commands.list`. */
  commands?: CommandRegistry;
  /** Toolset bundle registry — surfaces `toolsets.list` / `toolsets.resolve`. */
  toolsets?: ToolsetRegistry;
  /**
   * Read/write backend for config.json, powering `admin.config.full/set/unset`.
   * Optional — absent in tests/ephemeral deployments. The Settings UI hides
   * edit controls when `admin.config.full` reports `editable: false`.
   */
  configBackend?: ConfigBackend;
  /** Absolute path to config.json (only set when `configBackend` is). */
  configPath?: string;
  /**
   * Returns a JSON-shaped snapshot of the current live config. Used as a
   * read-only fallback when there is no `configBackend` wired up.
   */
  liveConfigSnapshot?: () => Record<string, unknown>;
  /** Testing seam: inject an LLMClient to bypass real provider calls. */
  clientOverride?: LLMClient;
  /**
   * Optional auto-titler. When present, chat dispatch fires it after the
   * first user message of an untitled session. Absent when
   * `chat.auto_title` is false in config.
   */
  titleGenerator?: import("./title-generator.js").TitleGenerator;
  /**
   * Optional HTTP API shim. When present, POST /v1/chat/completions and
   * /v1/messages are dispatched into this handler. Absent in tests.
   */
  httpApi?: HttpApiHandler;
  /** Trace registry — wired by boot, optional in tests. */
  traceRegistry?: import("./traces.js").TraceSessionRegistry;
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

/**
 * Resolve the dashboard's `dist/` directory. We look in this order:
 *
 *   1. `SQUAD_DASHBOARD_DIR` env var — explicit override, wins everything.
 *   2. `<gateway>/../dashboard/dist` — repo layout (`packages/gateway/{src,dist}` and
 *      `packages/dashboard/dist` are siblings).
 *   3. `<gateway>/../../@squad/dashboard/dist` — when the gateway is loaded via
 *      pnpm-linked `node_modules/@squad/gateway`.
 *   4. `<cwd>/dashboard/dist` and `<cwd>/packages/dashboard/dist` — last resort.
 *
 * Resolved lazily on every request (not cached at import time) so a dev who
 * builds the dashboard *after* starting the gateway gets it picked up
 * without a restart.
 */
function dashboardRoot(): string | null {
  if (process.env["SQUAD_DASHBOARD_DIR"]) {
    const explicit = process.env["SQUAD_DASHBOARD_DIR"];
    if (existsSync(join(explicit, "index.html"))) return explicit;
  }
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    // repo layout — works for both `src/server.ts` (tsx/vitest) and `dist/server.js`
    // because both live two levels deep inside packages/gateway/.
    resolvePath(here, "../../dashboard/dist"),
    // pnpm node_modules sibling layout
    resolvePath(here, "../../../dashboard/dist"),
    resolvePath(here, "../../../../@squad/dashboard/dist"),
    // cwd-relative fallbacks
    resolvePath(process.cwd(), "dashboard/dist"),
    resolvePath(process.cwd(), "packages/dashboard/dist"),
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return null;
}

/** Exposed for boot()-time logging only — the HTTP path always re-resolves. */
export function dashboardRootForLogging(): string | null {
  return dashboardRoot();
}

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
  // ── Browser pairing — unauthenticated by design ───────────────────────
  // The whole point: a browser with no token can ask for a pairing code
  // and then poll for approval. Approval still requires a CLI operator,
  // so the dispatcher's auth model is preserved.
  if (deps.pairing && req.url && req.method === "POST" && req.url === "/pair/begin") {
    void readJson(req)
      .then((body) => {
        const label = typeof (body as Record<string, unknown>)?.label === "string"
          ? ((body as Record<string, unknown>).label as string)
          : undefined;
        const view = deps.pairing!.begin({ ...(label !== undefined ? { label } : {}) });
        deps.broadcast.publish("pair.requested", { pairing: view });
        sendJson(res, 200, { pairing: view });
      })
      .catch(() => sendJson(res, 400, { error: "invalid body" }));
    return;
  }
  if (deps.pairing && req.method === "GET" && (req.url === "/pair/poll" || req.url?.startsWith("/pair/poll?"))) {
    const url = new URL(req.url, "http://host");
    const code = url.searchParams.get("code");
    if (!code) {
      sendJson(res, 400, { error: "missing code" });
      return;
    }
    const result = deps.pairing.claim(code);
    sendJson(res, 200, result);
    return;
  }
  // ── Webhook-triggered routines ───────────────────────────────────────
  // POST /webhook/<routine-id> fires a routine whose schedule.kind === "webhook".
  // Authenticated via the schedule's auth mode (none / secret / hmac).
  if (
    deps.routineStore &&
    deps.routineRunner &&
    req.method === "POST" &&
    typeof req.url === "string" &&
    req.url.startsWith("/webhook/")
  ) {
    void handleWebhook(req, res, deps).catch((err) => {
      deps.logger.error({ err }, "webhook handler crashed");
      sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  // ── HTTP API shim (OpenAI / Anthropic compat) ─────────────────────────
  if (deps.httpApi && req.method === "POST" && typeof req.url === "string") {
    const u = new URL(req.url, "http://host");
    if (u.pathname === "/v1/chat/completions" || u.pathname === "/v1/messages") {
      void deps.httpApi
        .handle(u.pathname, req, res)
        .catch((err) => {
          deps.logger.error({ err, path: u.pathname }, "http api handler crashed");
          sendJson(res, 500, { error: "internal error" });
        });
      return;
    }
  }
  // Dashboard static assets at / and /assets/*. Resolve per request so a
  // dashboard built after gateway start gets picked up.
  const root = dashboardRoot();
  if (root && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://host");
    const urlPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(root, urlPath);
    if (!filePath.startsWith(root + sep) && filePath !== join(root, "index.html")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (serveStatic(res, filePath)) return;
    // SPA fallback: serve index.html for unmatched routes that don't look
    // like asset requests (so a missing /assets/foo.js still 404s and the
    // browser shows the real error).
    if (!url.pathname.startsWith("/assets/") && serveStatic(res, join(root, "index.html"))) return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end(
    root
      ? `not found: ${req.url ?? "/"}\n`
      : `dashboard not built — run \`pnpm -F @squad/dashboard build\` (or set SQUAD_DASHBOARD_DIR)\n`,
  );
}

function buildDispatcher(deps: GatewayDeps): Dispatcher {
  const d = new Dispatcher();
  const primaryModel = deps.config.llm.primary.model;
  const fallbackModels = deps.config.llm.fallbacks.map((f) => f.model);
  registerSessionMethods(d, deps.sessions, {
    defaultModel: primaryModel,
    defaultFallbacks: fallbackModels,
    messages: deps.messages,
    toolCalls: deps.toolCalls,
    ...(deps.sessionIngestion ? { ingestion: deps.sessionIngestion } : {}),
    skipSubagentIngestion: !(deps.ingestSubagents ?? false),
  });
  registerChatMethods(d, {
    sessions: deps.sessions,
    messages: deps.messages,
    toolCalls: deps.toolCalls,
    broadcast: deps.broadcast,
    logger: deps.logger,
    toolRegistry: deps.toolRegistry,
    ...(deps.toolGroups ? { toolGroups: deps.toolGroups } : {}),
    defaultModel: primaryModel,
    defaultFallbacks: fallbackModels,
    coordinator: deps.coordinator,
    workspaceDir: deps.workspaceDir,
    ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
    ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
    ...(deps.titleGenerator ? { titleGenerator: deps.titleGenerator } : {}),
    ...(deps.traceRegistry ? { traceRegistry: deps.traceRegistry } : {}),
  });
  registerTaskMethods(d, deps.tasks, deps.broadcast);
  registerQuestionMethods(d, deps.questions);
  registerSubagentMethods(d, {
    pool: deps.subagentPool,
    registry: deps.subagentRegistry,
    sessions: deps.sessions,
    ...(deps.subagentDefStore ? { defStore: deps.subagentDefStore } : {}),
    workspaceDir: deps.workspaceDir,
    defaultModel: deps.config.llm.primary.model,
  });

  if (deps.approvals) {
    registerApprovalMethods(d, {
      approvals: deps.approvals,
      ...(deps.approvalRules ? { rules: deps.approvalRules } : {}),
    });
  }
  if (deps.plugins) registerPluginMethods(d, deps.plugins);
  if (deps.channels) registerChannelMethods(d, deps.channels);
  if (deps.routineStore && deps.routineRunner) {
    registerRoutineMethods(d, {
      store: deps.routineStore,
      runner: deps.routineRunner,
      ...(deps.cronPaths ? { paths: deps.cronPaths } : {}),
    });
  }
  if (deps.commands) registerCommandMethods(d, deps.commands);
  if (deps.toolsets) registerToolsetMethods(d, deps.toolsets);

  // Identity + peers need a PeerSource. When boot() doesn't pass one (test
  // harness), synthesize a minimal in-process source so admin.peers still
  // returns something well-formed.
  const peers =
    deps.peers ??
    new PeerSource({
      selfName: deps.config.server.squad_name,
      selfPort: deps.config.server.port,
    });

  const adminPairing = deps.pairing;
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
      requireForTools: deps.config.policy.approvals.require_for_tools,
      timeoutSeconds: deps.config.policy.approvals.timeout_seconds,
    },
    toolRegistry: deps.toolRegistry,
    squadName: deps.config.server.squad_name,
    squadPort: deps.config.server.port,
    squadHost: deps.config.server.host === "0.0.0.0" ? "127.0.0.1" : deps.config.server.host,
    build: deps.config.server.build || deps.version,
    peers,
    ...(adminPairing ? { pairing: adminPairing } : {}),
    ...(deps.configBackend ? { configBackend: deps.configBackend } : {}),
    ...(deps.configPath ? { configPath: deps.configPath } : {}),
    ...(deps.liveConfigSnapshot ? { liveConfigSnapshot: deps.liveConfigSnapshot } : {}),
  });
  return d;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function lowercaseHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v[v.length - 1] ?? "";
  }
  return out;
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GatewayDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://host");
  // Path is /webhook/<routine-id> with no further segments.
  const id = url.pathname.replace(/^\/webhook\//, "").replace(/\/$/, "");
  if (!id) {
    sendJson(res, 404, { error: "missing routine id" });
    return;
  }
  const job = deps.routineStore!.getJob(id);
  if (!job) {
    sendJson(res, 404, { error: "unknown routine" });
    return;
  }
  if (job.schedule.kind !== "webhook") {
    sendJson(res, 404, { error: "routine is not webhook-scheduled" });
    return;
  }
  if (!job.enabled) {
    sendJson(res, 423, { error: "routine disabled" });
    return;
  }

  const headers = lowercaseHeaders(req);
  const rawBody = await readBody(req);
  const auth = job.schedule.auth ?? "secret";
  if (auth === "secret") {
    const provided =
      url.searchParams.get("token") ??
      (() => {
        const a = headers["authorization"];
        if (!a) return null;
        const m = /^Bearer\s+(.+)$/i.exec(a);
        return m ? m[1]! : null;
      })();
    if (!provided || !job.schedule.secret || !safeEq(provided, job.schedule.secret)) {
      sendJson(res, 401, { error: "invalid token" });
      return;
    }
  } else if (auth === "hmac") {
    const sig = headers["x-squad-signature"];
    if (!sig || !job.schedule.secret) {
      sendJson(res, 401, { error: "missing signature" });
      return;
    }
    const expected = createHmac("sha256", job.schedule.secret).update(rawBody).digest("hex");
    if (!safeEq(sig, expected)) {
      sendJson(res, 401, { error: "bad signature" });
      return;
    }
  }

  let parsedBody: unknown = rawBody;
  if (rawBody.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      // Leave parsedBody as the raw string when not JSON.
    }
  }
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== "token") query[k] = v;
  });

  try {
    const result = await deps.routineStore!.fireWebhook(id, deps.routineRunner!, {
      body: parsedBody,
      headers,
      query,
      rawBody,
    });
    sendJson(res, 200, { ok: true, sessionId: result.sessionId });
  } catch (err) {
    deps.logger.error({ err, routineId: id }, "webhook routine fire failed");
    sendJson(res, 500, { error: err instanceof Error ? err.message : "fire failed" });
  }
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}
