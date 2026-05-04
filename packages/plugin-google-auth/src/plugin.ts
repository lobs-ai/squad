import { join } from "node:path";
import { definePlugin, PROMPT_SLOTS } from "@squad/plugin-sdk";
import { GoogleAuthStore } from "./store.js";
import { GoogleAuthService, setSharedGoogleAuth } from "./service.js";
import {
  buildAccountsHandler,
  buildCallbackHandler,
  buildConnectHandler,
} from "./routes.js";
import { googleAuthGroup, registerGoogleAuthTools } from "./tools.js";

interface Config {
  /** OAuth client id (Google Cloud → APIs & Services → Credentials). */
  client_id?: string;
  client_secret?: string;
  /** Redirect URI registered with Google — must include the gateway's host. */
  redirect_uri?: string;
  /** Filesystem path to the sqlite file that holds connected accounts. */
  db_path?: string;
  /** Passphrase used to derive the AES-256 key for token encryption. */
  encryption_key?: string;
  /** Public base URL the gateway is reachable at, used to mint connect URLs. */
  base_url?: string;
  /** Where to redirect the user after a successful connect. */
  success_redirect?: string;
  /** Where to redirect the user after a failed connect. */
  error_redirect?: string;
  /** Override OAuth scopes if your app has narrower needs. */
  scopes?: string[];
}

function readString(value: unknown, fallbackEnv: string | null): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (fallbackEnv) {
    const v = process.env[fallbackEnv];
    if (v && v.trim().length > 0) return v.trim();
  }
  return null;
}

export default definePlugin({
  id: "@squad/plugin-google-auth",
  name: "Google OAuth",
  version: "0.0.1",
  kinds: ["tool"],
  register(api) {
    const cfg = api.config as Config;

    const clientId = readString(cfg.client_id, "GOOGLE_CLIENT_ID");
    const clientSecret = readString(cfg.client_secret, "GOOGLE_CLIENT_SECRET");
    const redirectUri =
      readString(cfg.redirect_uri, "GOOGLE_REDIRECT_URI") ??
      "http://localhost:8787/oauth/google/callback";
    const baseUrl = readString(cfg.base_url, "SQUAD_BASE_URL") ?? "http://localhost:8787";

    if (!clientId || !clientSecret) {
      api.logger.warn(
        "google-auth: client_id / client_secret not configured — set them in plugin config or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Plugin will load but connections will fail.",
      );
    }

    const dbPath =
      readString(cfg.db_path, "SQUAD_GOOGLE_AUTH_DB") ??
      join(process.cwd(), "data", "google-auth.db");

    const encryptionKey =
      readString(cfg.encryption_key, "SQUAD_GOOGLE_AUTH_KEY") ??
      readString(null, "SQUAD_DATA_KEY") ??
      "squad-google-auth-default-key-change-me";

    const store = new GoogleAuthStore({ dbPath, encryptionKey });
    const service = new GoogleAuthService({
      store,
      creds: {
        clientId: clientId ?? "",
        clientSecret: clientSecret ?? "",
        redirectUri,
      },
      ...(cfg.scopes ? { scopes: cfg.scopes } : {}),
    });
    setSharedGoogleAuth(service);

    // ── HTTP routes ──────────────────────────────────────────────────────
    const routeDeps = {
      service,
      ...(cfg.success_redirect ? { successRedirect: cfg.success_redirect } : {}),
      ...(cfg.error_redirect ? { errorRedirect: cfg.error_redirect } : {}),
    };
    api.http.register("GET", "/oauth/google/connect", buildConnectHandler(routeDeps));
    api.http.register("GET", "/oauth/google/callback", buildCallbackHandler(routeDeps));
    api.http.register("GET", "/oauth/google/accounts", buildAccountsHandler(routeDeps));

    // ── Agent-facing tools ───────────────────────────────────────────────
    // Lazy-loadable group: tools stay hidden in the system prompt until the
    // agent calls describe_tool_group({groups: "google_auth"}).
    api.toolGroups.register(googleAuthGroup);
    registerGoogleAuthTools(api.tools, service, baseUrl);

    // ── Prompt fragments ─────────────────────────────────────────────────
    const credsMissing = !clientId || !clientSecret;
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content:
        "google-auth: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured — google_connect_url, " +
        "gmail_*, google_calendar_*, google_drive_* will all fail. Tell the user to set them in plugin " +
        "config or env before retrying.",
      when: () => credsMissing,
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content:
        "google-auth: no Google accounts connected — call google_connect_url and hand the URL to the user " +
        "before any gmail / calendar / drive call.",
      when: () => service.listAccounts().length === 0,
    });
    const encryptionKeyIsDefault = encryptionKey === "squad-google-auth-default-key-change-me";
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content:
        "google-auth: token encryption key falling back to the built-in default — connected tokens are " +
        "not meaningfully encrypted at rest. Tell the user to set SQUAD_GOOGLE_AUTH_KEY.",
      when: () => encryptionKeyIsDefault,
    });

    api.logger.info("google-auth plugin ready", {
      accounts: service.listAccounts().length,
      clientConfigured: Boolean(clientId && clientSecret),
      redirectUri,
    });

    return () => {
      store.close();
    };
  },
});
