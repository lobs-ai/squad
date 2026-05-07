/**
 * @squad/app-sdk — tiny helper for building web apps that plug into Squad's
 * `/apps/<name>/*` proxy.
 *
 * Two flavours:
 *
 *   1. `createApp({...})` — a zero-dep router. Use it for quick scripts where
 *      you don't already have an HTTP framework.
 *
 *      ```ts
 *      const app = createApp({ name: "weather", title: "Weather Map" });
 *      app.get("/", (_, res) => res.send("<h1>Hello</h1>"));
 *      const { port } = await app.start();
 *      ```
 *
 *   2. `wrap(server, {...})` — decorates an existing `http.Server` (Express,
 *      Fastify, plain Node). It mounts `/squad/info` and `/squad/health` in
 *      front of your handler so the gateway's prober has something to hit.
 *
 *      ```ts
 *      const server = http.createServer(myHandler);
 *      await wrap(server, { name: "weather", title: "Weather Map" });
 *      ```
 *
 * Either way, once the underlying server is listening the SDK prints a single
 * line of JSON to stdout:
 *
 *   {"squad_app_ready":{"name":"weather","port":53201,"pid":1234}}
 *
 * The agent that spawned the process reads this line and calls `expose_app`
 * — no polling, no health-flap window before the dashboard sees the app.
 */

import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

export interface AppMeta {
  /** URL slug — must match `[a-z0-9][a-z0-9-]*`. */
  name: string;
  /** Human-readable title shown in the dashboard. */
  title: string;
  /** Optional one-liner shown beneath the title. */
  description?: string;
  /** App version, surfaced in /squad/info. Defaults to "0.0.0". */
  version?: string;
}

export interface SquadInfoPayload extends AppMeta {
  pid: number;
  /** Wall-clock ms when the SDK printed its ready banner. */
  startedAt: number;
}

export type AppHandler = (
  req: IncomingMessage,
  res: ResponseHelper,
  ctx: { params: Record<string, string>; url: URL },
) => void | Promise<void>;

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: AppHandler;
}

/**
 * Light wrapper around ServerResponse so handlers don't have to think about
 * status codes / content-type for the common cases. Agents writing apps
 * usually want `.send` (auto-detect HTML vs text) or `.json`.
 */
export class ResponseHelper {
  constructor(public readonly raw: ServerResponse) {}

  status(code: number): this {
    this.raw.statusCode = code;
    return this;
  }

  json(body: unknown): void {
    this.raw.writeHead(this.raw.statusCode || 200, {
      "content-type": "application/json; charset=utf-8",
    });
    this.raw.end(JSON.stringify(body));
  }

  text(body: string): void {
    this.raw.writeHead(this.raw.statusCode || 200, {
      "content-type": "text/plain; charset=utf-8",
    });
    this.raw.end(body);
  }

  html(body: string): void {
    this.raw.writeHead(this.raw.statusCode || 200, {
      "content-type": "text/html; charset=utf-8",
    });
    this.raw.end(body);
  }

  /** HTML if the body looks like markup, else text. */
  send(body: string): void {
    if (/^\s*<(!doctype|html|head|body|div|h[1-6]|p|span|section|main|article)/i.test(body)) {
      this.html(body);
    } else {
      this.text(body);
    }
  }

  redirect(location: string, code: 301 | 302 | 303 | 307 | 308 = 302): void {
    this.raw.writeHead(code, { location });
    this.raw.end();
  }

  notFound(message = "not found"): void {
    this.status(404).text(message);
  }
}

interface CreateAppOptions extends AppMeta {
  /** Port to bind. Defaults to 0 (OS picks a free one). */
  port?: number;
  /** Host to bind. Defaults to 127.0.0.1 — apps must stay loopback-only. */
  host?: string;
}

export interface AppHandle {
  readonly meta: AppMeta;
  readonly port: number;
  readonly server: HttpServer;
  /** Add a GET / POST / PUT / DELETE / PATCH route. */
  get(path: string, handler: AppHandler): this;
  post(path: string, handler: AppHandler): this;
  put(path: string, handler: AppHandler): this;
  delete(path: string, handler: AppHandler): this;
  patch(path: string, handler: AppHandler): this;
  use(handler: AppHandler): this;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
}

/**
 * Build a standalone app with a tiny built-in router. Use for scripts where
 * pulling in Express is overkill. For anything bigger, use `wrap()` over your
 * own framework.
 */
export function createApp(options: CreateAppOptions): AppHandle {
  validateMeta(options);
  const meta: AppMeta = {
    name: options.name,
    title: options.title,
    ...(options.description !== undefined ? { description: options.description } : {}),
    version: options.version ?? "0.0.0",
  };
  const routes: Route[] = [];
  const fallbacks: AppHandler[] = [];

  const addRoute = (method: string, path: string, handler: AppHandler): void => {
    const { pattern, paramNames } = compilePath(path);
    routes.push({ method, pattern, paramNames, handler });
  };

  const startedAt = Date.now();
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://app.local");
    const helper = new ResponseHelper(res);

    if (url.pathname === "/squad/health" && req.method === "GET") {
      helper.json({ ok: true });
      return;
    }
    if (url.pathname === "/squad/info" && req.method === "GET") {
      helper.json(buildInfoPayload(meta, startedAt));
      return;
    }

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((n, i) => {
        params[n] = decodeURIComponent(m[i + 1] ?? "");
      });
      try {
        await route.handler(req, helper, { params, url });
      } catch (err) {
        if (!res.headersSent) {
          helper.status(500).text((err as Error).message);
        } else {
          res.end();
        }
      }
      return;
    }
    for (const fb of fallbacks) {
      if (res.headersSent) return;
      try {
        await fb(req, helper, { params: {}, url });
        if (res.headersSent) return;
      } catch (err) {
        if (!res.headersSent) helper.status(500).text((err as Error).message);
        return;
      }
    }
    helper.notFound();
  };

  const server = nodeCreateServer((req, res) => void handler(req, res));

  const handle: AppHandle = {
    meta,
    get port(): number {
      const a = server.address();
      return typeof a === "object" && a ? a.port : options.port ?? 0;
    },
    server,
    get(path, h) { addRoute("GET", path, h); return handle; },
    post(path, h) { addRoute("POST", path, h); return handle; },
    put(path, h) { addRoute("PUT", path, h); return handle; },
    delete(path, h) { addRoute("DELETE", path, h); return handle; },
    patch(path, h) { addRoute("PATCH", path, h); return handle; },
    use(h) { fallbacks.push(h); return handle; },
    start: () => start(server, options.host ?? "127.0.0.1", options.port ?? 0, meta, startedAt),
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
  return handle;
}

interface WrapOptions extends AppMeta {
  port?: number;
  host?: string;
}

/**
 * Decorate an existing http.Server so requests to /squad/info and
 * /squad/health are served by the SDK before reaching your handler. Returns
 * a promise that resolves once the server is listening and the ready banner
 * has been printed.
 */
export async function wrap(
  server: HttpServer,
  options: WrapOptions,
): Promise<{ port: number; meta: AppMeta }> {
  validateMeta(options);
  const meta: AppMeta = {
    name: options.name,
    title: options.title,
    ...(options.description !== undefined ? { description: options.description } : {}),
    version: options.version ?? "0.0.0",
  };
  const startedAt = Date.now();
  const existing = server.listeners("request").slice();
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://app.local");
    if (url.pathname === "/squad/health" && req.method === "GET") {
      new ResponseHelper(res).json({ ok: true });
      return;
    }
    if (url.pathname === "/squad/info" && req.method === "GET") {
      new ResponseHelper(res).json(buildInfoPayload(meta, startedAt));
      return;
    }
    for (const fn of existing) {
      (fn as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
    }
  });
  const result = await start(server, options.host ?? "127.0.0.1", options.port ?? 0, meta, startedAt);
  return { port: result.port, meta };
}

// -- internals --------------------------------------------------------------

function start(
  server: HttpServer,
  host: string,
  port: number,
  meta: AppMeta,
  startedAt: number,
): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      printReady(meta, p, startedAt);
      resolve({ port: p });
      return;
    }
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      printReady(meta, p, startedAt);
      server.removeListener("error", reject);
      resolve({ port: p });
    });
  });
}

function buildInfoPayload(meta: AppMeta, startedAt: number): SquadInfoPayload {
  return {
    name: meta.name,
    title: meta.title,
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    version: meta.version ?? "0.0.0",
    pid: process.pid,
    startedAt,
  };
}

/**
 * Single-line JSON banner the spawning agent uses to detect readiness.
 * Keep the shape stable — it's part of the contract between the SDK and
 * the agent's child-process wrapper.
 */
function printReady(meta: AppMeta, port: number, startedAt: number): void {
  const payload = {
    squad_app_ready: {
      name: meta.name,
      title: meta.title,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      port,
      pid: process.pid,
      startedAt,
      version: meta.version ?? "0.0.0",
    },
  };
  // Avoid console.log so callers that override stdout still see it.
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function validateMeta(meta: AppMeta): void {
  if (!NAME_RE.test(meta.name)) {
    throw new Error(`app name must match ${NAME_RE} (lowercase, digits, hyphens), got: ${meta.name}`);
  }
  if (!meta.title || meta.title.trim().length === 0) {
    throw new Error("app title is required");
  }
}

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    })
    .join("/");
  return { pattern: new RegExp(`^${escaped}$`), paramNames };
}
