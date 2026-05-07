import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import type { AppRegistry } from "./registry.js";
import type { Logger } from "../logger.js";

/**
 * Match `/apps/<name>` and `/apps/<name>/<rest>`. Case-sensitive — names are
 * lowercased on registration.
 */
const APPS_PATH_RE = /^\/apps\/([a-z0-9][a-z0-9-]*)(\/.*)?$/;

export interface AppRouteMatch {
  name: string;
  /** Path forwarded to the upstream — always starts with `/`. */
  upstreamPath: string;
}

export function matchAppPath(pathname: string): AppRouteMatch | null {
  const m = APPS_PATH_RE.exec(pathname);
  if (!m) return null;
  const name = m[1]!;
  const rest = m[2] ?? "/";
  return { name, upstreamPath: rest };
}

/**
 * Proxy a single HTTP request to the registered app. Streams body in both
 * directions so SSE / chunked responses work. The upstream connection
 * timeout is short (5s) so a dead app fails fast rather than hanging the
 * gateway.
 */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  match: AppRouteMatch,
  registry: AppRegistry,
  logger: Logger,
  search: string,
): void {
  const app = registry.get(match.name);
  if (!app) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`unknown app: ${match.name}\n`);
    return;
  }

  // Strip hop-by-hop headers and rewrite Host to the upstream so the app
  // can't accidentally generate absolute redirects pointing at the gateway.
  const upstreamHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host") continue;
    upstreamHeaders[lower] = v;
  }
  upstreamHeaders["host"] = `${app.host}:${app.port}`;
  // Pass-through info for the upstream.
  const xfwd = req.headers["x-forwarded-for"];
  const fwd = req.socket.remoteAddress ?? "";
  upstreamHeaders["x-forwarded-for"] = xfwd ? `${xfwd}, ${fwd}` : fwd;
  upstreamHeaders["x-forwarded-proto"] =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  upstreamHeaders["x-forwarded-prefix"] = `/apps/${app.name}`;

  const upstream = httpRequest(
    {
      host: app.host,
      port: app.port,
      method: req.method ?? "GET",
      path: match.upstreamPath + search,
      headers: upstreamHeaders,
    },
    (uRes) => {
      const status = uRes.statusCode ?? 502;
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(uRes.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers[k] = v as string | string[];
      }
      res.writeHead(status, headers);
      uRes.pipe(res);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    logger.warn({ err: String(err), app: app.name, path: match.upstreamPath }, "app proxy error");
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`app upstream error: ${(err as Error).message}\n`);
  });
  req.pipe(upstream);
}

/**
 * Proxy an HTTP/1.1 WebSocket upgrade. The gateway already extracted the
 * pathname; we open a raw TCP socket to the upstream and pipe both ways.
 * Used for live-reload / dev-server scenarios.
 */
export function proxyWebSocketUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  match: AppRouteMatch,
  registry: AppRegistry,
  logger: Logger,
  search: string,
): void {
  const app = registry.get(match.name);
  if (!app) {
    clientSocket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstream = netConnect({ host: app.host, port: app.port }, () => {
    // Replay the client's request line + headers against the upstream,
    // rewriting the path. We can't use http.request here because the upgrade
    // semantics are simplest with a raw socket — and the upstream is already
    // a localhost connection inside the same container.
    const headerLines: string[] = [];
    headerLines.push(
      `${req.method ?? "GET"} ${match.upstreamPath + search} HTTP/1.1`,
    );
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "upgrade" && k.toLowerCase() !== "connection") continue;
      const values = Array.isArray(v) ? v : [v];
      for (const val of values) headerLines.push(`${k}: ${val}`);
    }
    headerLines.push(`host: ${app.host}:${app.port}`);
    headerLines.push(`x-forwarded-prefix: /apps/${app.name}`);
    headerLines.push("");
    headerLines.push("");
    upstream.write(headerLines.join("\r\n"));
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (err) => {
    logger.warn({ err: String(err), app: app.name }, "app ws upgrade error");
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
  });
  clientSocket.on("error", () => upstream.destroy());
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
