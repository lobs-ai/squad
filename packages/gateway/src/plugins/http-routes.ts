import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  HttpMethod,
  PluginHttpHandler,
  PluginHttpHandlerCtx,
} from "@squad/plugin-sdk";
import type { Logger } from "../logger.js";

interface Route {
  method: HttpMethod;
  /** Matched path. Trailing `/*` makes it a prefix match. */
  path: string;
  handler: PluginHttpHandler;
  prefix: string | null; // non-null for `/foo/*`-style routes
  /** Plugin id that owns this route, so unloads can drop it. */
  pluginId: string;
}

/**
 * In-memory registry of plugin-contributed HTTP routes. The gateway's HTTP
 * dispatcher consults this between its built-in paths and the dashboard
 * static fallback. Routes with `/*` suffixes are prefix matches; everything
 * else is exact.
 */
export class PluginRouteRegistry {
  private readonly routes: Route[] = [];

  constructor(private readonly logger: Logger) {}

  register(
    method: HttpMethod,
    path: string,
    handler: PluginHttpHandler,
    pluginId: string,
  ): void {
    if (!path.startsWith("/")) {
      throw new Error(`plugin route path must start with "/", got ${path}`);
    }
    const prefix = path.endsWith("/*")
      ? path.slice(0, -2) // drop "/*" but keep leading slash
      : null;
    // Conflict detection: silently last-write-wins is too surprising. Reject
    // overlapping exact matches; prefix routes shadow each other only when the
    // prefix is identical, which we also reject.
    for (const r of this.routes) {
      if (r.method === method && r.path === path) {
        throw new Error(`duplicate plugin route: ${method} ${path}`);
      }
    }
    this.routes.push({ method, path, handler, prefix, pluginId });
    this.logger.info({ method, path, pluginId }, "plugin http route registered");
  }

  /**
   * Drop every route owned by `pluginId`. Called by the host when a plugin
   * unloads so its endpoints stop responding (and don't conflict on a later
   * reinstall).
   */
  removeForPlugin(pluginId: string): void {
    let removed = 0;
    for (let i = this.routes.length - 1; i >= 0; i--) {
      if (this.routes[i]!.pluginId === pluginId) {
        this.routes.splice(i, 1);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.info({ pluginId, removed }, "plugin http routes removed");
    }
  }

  /**
   * Look up a route for a given (method, pathname). Returns null when nothing
   * matches; callers are expected to fall through to the next dispatcher
   * branch (e.g. dashboard statics).
   */
  match(method: string, pathname: string): { route: Route; wildcardPath: string } | null {
    // Exact matches win over prefix matches.
    for (const r of this.routes) {
      if (r.method !== method) continue;
      if (r.prefix !== null) continue;
      if (r.path === pathname) return { route: r, wildcardPath: "" };
    }
    for (const r of this.routes) {
      if (r.method !== method) continue;
      if (r.prefix === null) continue;
      const sep = r.prefix.endsWith("/") ? r.prefix : `${r.prefix}/`;
      if (pathname === r.prefix || pathname.startsWith(sep)) {
        const tail = pathname.slice(sep.length);
        return { route: r, wildcardPath: tail };
      }
    }
    return null;
  }

  count(): number {
    return this.routes.length;
  }
}

export function buildHandlerCtx(
  req: IncomingMessage,
  url: URL,
  wildcardPath: string,
): PluginHttpHandlerCtx {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
    else if (Array.isArray(v)) headers[k.toLowerCase()] = v[v.length - 1] ?? "";
  }
  let bodyPromise: Promise<Buffer> | null = null;
  const readBody = (): Promise<Buffer> => {
    if (!bodyPromise) {
      bodyPromise = (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
      })();
    }
    return bodyPromise;
  };
  const readJson = async (): Promise<unknown> => {
    const buf = await readBody();
    const raw = buf.toString("utf8");
    if (raw.trim().length === 0) return {};
    return JSON.parse(raw);
  };
  return { url, wildcardPath, headers, readBody, readJson };
}

export async function dispatchPluginRoute(
  registry: PluginRouteRegistry,
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "host"}`);
  const match = registry.match(req.method ?? "GET", url.pathname);
  if (!match) return false;
  try {
    const ctx = buildHandlerCtx(req, url, match.wildcardPath);
    await match.route.handler(req, res, ctx);
  } catch (err) {
    logger.error({ err, method: req.method, path: url.pathname }, "plugin http handler crashed");
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "plugin handler crashed" }));
    }
  }
  return true;
}
