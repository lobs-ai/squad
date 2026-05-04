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

    // Prefer `api.runtime.publicBaseUrl` over `process.env.SQUAD_BASE_URL`:
    // the gateway computes runtime fresh from the live listen config every
    // boot, so it can't be poisoned by a stale secret-store entry from a
    // run on a different port. Plugin-config `base_url` still wins for
    // operators that need a different public host (rare; reverse proxies
    // typically come through the gateway's own SQUAD_BASE_URL operator
    // override before plugin load).
    const resolveBaseUrl = (): string =>
      readString(cfg.base_url, null) ?? api.runtime.publicBaseUrl ?? "";
    const resolveRedirectUri = (): string => {
      const explicit = readString(cfg.redirect_uri, "GOOGLE_REDIRECT_URI");
      if (explicit) return explicit;
      const base = resolveBaseUrl();
      return base ? `${base.replace(/\/$/, "")}/oauth/google/callback` : "";
    };

    const resolveCreds = (): {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    } => ({
      clientId: readString(cfg.client_id, "GOOGLE_CLIENT_ID") ?? "",
      clientSecret: readString(cfg.client_secret, "GOOGLE_CLIENT_SECRET") ?? "",
      redirectUri: resolveRedirectUri(),
    });

    if (!resolveCreds().clientId || !resolveCreds().clientSecret) {
      api.logger.warn(
        "google-auth: client_id / client_secret not configured — set them in plugin config or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Plugin will load but connections will fail until set_env is called.",
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
      creds: resolveCreds,
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
    registerGoogleAuthTools(api.tools, service, resolveBaseUrl);

    // ── Prompt fragments ─────────────────────────────────────────────────
    const credsMissing = (): boolean => {
      const c = resolveCreds();
      return !c.clientId || !c.clientSecret;
    };
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content: [
        "google-auth: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured — google_connect_url,",
        "gmail_*, google_calendar_*, google_drive_* will all fail (Google's consent screen will reject",
        "the request with 'invalid_request — Missing required parameter: client_id'). The agent owns",
        "the gateway side of fixing this; the user only has to provision an OAuth client in the Google",
        "Cloud console and hand back two strings. See describe_tool_group({groups:'google_auth'}) for",
        "the full GCP click-path. Short version of what the agent does:",
        "  1. Walk the user through creating an OAuth 2.0 Web-application client in GCP and registering",
        `     this exact redirect URI on it: ${resolveRedirectUri()}`,
        "  2. Ask the user to open the downloaded `client_secret_*.json` and paste back",
        "     `web.client_id` and `web.client_secret`. The file itself is NOT read by the gateway —",
        "     dropping it into ~/.squad does nothing. Only those two strings matter.",
        "  3. Persist them with set_env — survives restarts and the plugin re-reads process.env on",
        "     each OAuth call, so this takes effect immediately (no gateway restart needed):",
        "       set_env({name: 'GOOGLE_CLIENT_ID',     value: <client_id>})",
        "       set_env({name: 'GOOGLE_CLIENT_SECRET', value: <client_secret>})",
        "     Never tell the user to edit .env, export shell vars, or touch config.json themselves.",
      ].join("\n"),
      when: credsMissing,
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content: [
        "google-auth: no Google accounts connected — gmail / calendar / drive tools will all fail until",
        "at least one account is OAuthed in. Call google_connect_url, hand the URL to the user, and wait",
        "for them to confirm the consent screen before retrying. Do NOT try to follow the OAuth flow",
        "from the agent. (If the consent screen errors with 'Missing required parameter: client_id',",
        "the upstream issue is missing app credentials — see the credentials warning above.)",
      ].join("\n"),
      when: () => service.listAccounts().length === 0,
    });
    const encryptionKeyIsDefault = encryptionKey === "squad-google-auth-default-key-change-me";
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content: [
        "google-auth: token encryption key is falling back to the hard-coded default — any tokens written",
        "to data/google-auth.db (or the configured db_path) are encrypted with a key that ships in the",
        "source, so they are effectively plaintext to anyone with read access to the file. Tell the user",
        "to export SQUAD_GOOGLE_AUTH_KEY (or set encryption_key in plugin config) to a long random",
        "passphrase BEFORE connecting any account — rotating the key after the fact orphans existing",
        "tokens and forces every account to reconnect.",
      ].join("\n"),
      when: () => encryptionKeyIsDefault,
    });

    const initial = resolveCreds();
    api.logger.info("google-auth plugin ready", {
      accounts: service.listAccounts().length,
      clientConfigured: Boolean(initial.clientId && initial.clientSecret),
      redirectUri: initial.redirectUri,
    });

    return () => {
      store.close();
    };
  },
});
