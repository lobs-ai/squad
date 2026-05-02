import type { IncomingMessage, ServerResponse } from "node:http";
import type { GoogleAuthService } from "./service.js";

export interface RouteDeps {
  service: GoogleAuthService;
  /** Where to send the user after a successful connect. Defaults to `/`. */
  successRedirect?: string;
  /** Where to send the user after a failed connect. Defaults to `/`. */
  errorRedirect?: string;
}

/**
 * GET /oauth/google/connect — mints a CSRF state and 302s to Google's
 * consent screen. The browser ends up here when the user clicks "connect
 * Google" in any UI surface.
 */
export function buildConnectHandler(deps: RouteDeps) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const state = deps.service.mintState();
    const url = deps.service.buildAuthUrl(state);
    res.writeHead(302, { location: url });
    res.end();
  };
}

/**
 * GET /oauth/google/callback?code=…&state=… — exchanges the code, persists
 * the resulting tokens, and 302s back to the success redirect.
 */
export function buildCallbackHandler(deps: RouteDeps) {
  const successRedirect = deps.successRedirect ?? "/";
  const errorRedirect = deps.errorRedirect ?? "/";
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "host"}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errParam = url.searchParams.get("error");
    if (errParam) {
      res.writeHead(302, { location: redirectWith(errorRedirect, { google_error: errParam }) });
      res.end();
      return;
    }
    if (!code || !state) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing code or state" }));
      return;
    }
    if (!deps.service.consumeState(state)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or expired state" }));
      return;
    }
    try {
      const { tokens, email } = await deps.service.exchangeCode(code);
      deps.service.saveConnection({ tokens, email });
      res.writeHead(302, { location: redirectWith(successRedirect, { google_connected: email }) });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "exchange failed";
      res.writeHead(302, { location: redirectWith(errorRedirect, { google_error: msg }) });
      res.end();
    }
  };
}

/**
 * GET /oauth/google/accounts — read-only account listing as JSON. Useful for
 * UI surfaces that want to show "you have N Google accounts connected"
 * without speaking the dispatch protocol.
 */
export function buildAccountsHandler(deps: RouteDeps) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const accounts = deps.service.listAccounts();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accounts }));
  };
}

function redirectWith(target: string, params: Record<string, string>): string {
  // Avoid building absolute URLs — the gateway sits behind whatever proxy
  // the operator points at it, so the relative path is what survives.
  const sep = target.includes("?") ? "&" : "?";
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${target}${sep}${qs}`;
}
