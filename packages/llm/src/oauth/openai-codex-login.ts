/**
 * OpenAI Codex (ChatGPT subscription) OAuth login + refresh helpers.
 *
 * Squad runs the PKCE flow on the host (browser + localhost callback)
 * once, persists the resulting refresh_token somewhere the gateway can
 * read it (env var or volume-mounted file), and the gateway uses the
 * refresh_token to mint short-lived access tokens at runtime.
 *
 * Adapted from @mariozechner/pi-ai's oauth module. Kept dependency-free
 * so the llm package doesn't pick up a transitive runtime dep just for
 * the once-per-deployment login flow.
 *
 * NOTE: only safe to import in node — uses `node:http` for the callback
 * server. Browser bundlers will choke if this is statically imported on
 * the client side.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * OAuth client id for the ChatGPT/Codex subscription. This is the
 * canonical id baked into the codex CLI — the auth flow won't accept
 * anything else, so it's hard-coded here rather than configurable.
 */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
/** JWT claim path that carries the ChatGPT account id. */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexCredentials {
  /** Bearer access token used in the Authorization header. JWT, ~24h ttl. */
  access: string;
  /** Long-lived refresh token. The real credential. */
  refresh: string;
  /** Expiry in unix-ms. */
  expires: number;
  /** ChatGPT account id, decoded from the access JWT. */
  accountId?: string;
}

/**
 * Run the PKCE authorization-code flow and return fresh credentials.
 *
 * Opens (or asks the caller to open) the browser to authorize the app,
 * receives the code on a temporary localhost server, exchanges it for
 * tokens. Designed to be driven from a CLI on the host machine — the
 * resulting refresh token gets handed to the gateway via env var.
 */
export async function loginOpenAICodex(opts: {
  onAuthUrl: (url: string) => void;
  originator?: string;
  /** Override the host bound by the callback server. Defaults to 127.0.0.1. */
  callbackHost?: string;
}): Promise<CodexCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = randomBytes(16).toString("hex");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", opts.originator ?? "squad");

  const callbackHost = opts.callbackHost ?? REDIRECT_HOST;
  const server = await startCallbackServer(state, callbackHost);
  opts.onAuthUrl(url.toString());

  try {
    const code = await server.waitForCode();
    if (!code) throw new Error("OAuth flow cancelled before a code arrived");
    return await exchangeAuthorizationCode(code, verifier);
  } finally {
    server.close();
  }
}

/**
 * Trade a refresh token for a fresh access token. Returns the *new*
 * credentials — the refresh token may have rotated.
 */
export async function refreshOpenAICodexToken(
  refresh: string,
): Promise<CodexCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CodexAuthError(
      `Codex token refresh failed (${response.status}): ${text || response.statusText}`,
      { status: response.status },
    );
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    !json.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== "number"
  ) {
    throw new CodexAuthError(
      `Codex token refresh response missing fields: ${JSON.stringify(json)}`,
    );
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: getAccountIdFromJwt(json.access_token) ?? undefined,
  };
}

/** Errors from the refresh flow surface a status when one is available. */
export class CodexAuthError extends Error {
  status?: number;
  constructor(message: string, opts?: { status?: number }) {
    super(message);
    this.name = "CodexAuthError";
    if (opts?.status !== undefined) this.status = opts.status;
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<CodexCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new CodexAuthError(
      `Codex token exchange failed (${response.status}): ${text || response.statusText}`,
      { status: response.status },
    );
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    !json.access_token ||
    !json.refresh_token ||
    typeof json.expires_in !== "number"
  ) {
    throw new CodexAuthError(
      `Codex token exchange response missing fields: ${JSON.stringify(json)}`,
    );
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: getAccountIdFromJwt(json.access_token) ?? undefined,
  };
}

interface CallbackServer {
  close: () => void;
  waitForCode: () => Promise<string | null>;
}

function startCallbackServer(
  expectedState: string,
  host: string,
): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode: ((value: string | null) => void) | undefined;
    const codePromise = new Promise<string | null>((res) => {
      resolveCode = res;
    });

    const server: Server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname !== "/auth/callback") {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("Not found");
          return;
        }
        if (url.searchParams.get("state") !== expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("State mismatch");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain");
          res.end("Missing authorization code");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><meta charset="utf-8"><title>squad codex-auth</title>` +
            `<style>body{font-family:system-ui;margin:3rem;color:#222}</style>` +
            `<h2>Squad codex-auth login complete</h2>` +
            `<p>You can close this tab and return to the terminal.</p>`,
        );
        resolveCode?.(code);
      } catch (err) {
        res.statusCode = 500;
        res.end(`Internal error: ${(err as Error).message}`);
      }
    });

    server.once("error", (err) => {
      resolveCode?.(null);
      reject(err);
    });
    server.listen(REDIRECT_PORT, host, () => {
      resolve({
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
        waitForCode: () => codePromise,
      });
    });
  });
}

/**
 * PKCE verifier + challenge (S256). Uses Web Crypto so the helper is
 * importable from non-Node contexts too — node 20+ exposes
 * `globalThis.crypto`.
 */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(new Uint8Array(hash));
  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Pull the `chatgpt_account_id` out of the access JWT. The Codex
 * endpoint requires this id as the `ChatGPT-Account-Id` header — without
 * it, every request comes back 401 even with a valid access token.
 *
 * Exported for the CodexAuth service to call on refresh (which can return
 * a token without a discoverable account id in the credentials file).
 */
export function getAccountIdFromJwt(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1] ?? "";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4;
    const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const auth = parsed[JWT_CLAIM_PATH] as
      | { chatgpt_account_id?: string }
      | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Read the `exp` claim out of an access JWT, in unix-ms. */
export function getExpiryFromJwt(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1] ?? "";
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4;
    const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}
