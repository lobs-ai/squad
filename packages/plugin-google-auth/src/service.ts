import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import { randomBytes } from "node:crypto";
import { GoogleAuthStore, type GoogleAccount, type GoogleFeature } from "./store.js";

export interface GoogleOAuthCreds {
  clientId: string;
  clientSecret: string;
  /** Public redirect URI registered with Google. Must end in `/oauth/google/callback`. */
  redirectUri: string;
}

/**
 * Resolver invoked on every OAuth client construction. Lets the plugin re-read
 * `process.env` (or whatever source) on each call, so values written via
 * `set_env` after the plugin loaded are picked up without a gateway restart.
 */
export type GoogleOAuthCredsResolver = () => GoogleOAuthCreds;

export interface AuthedClient {
  client: OAuth2Client;
  account: GoogleAccount;
}

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Shared Google OAuth + token refresh service. Calendar / Gmail / Drive
 * plugins depend on this to fetch authenticated clients without each
 * re-implementing the dance.
 *
 * Single instance per gateway boot — the host stashes it on
 * `globalThis.__squadGoogleAuth` so cross-plugin lookup is trivial without
 * adding a new SDK surface.
 */
export class GoogleAuthService {
  private readonly store: GoogleAuthStore;
  private readonly resolveCreds: GoogleOAuthCredsResolver;
  private readonly scopes: string[];
  private readonly stateStore = new Map<string, { expires: number }>();

  constructor(opts: {
    store: GoogleAuthStore;
    creds: GoogleOAuthCreds | GoogleOAuthCredsResolver;
    scopes?: string[];
  }) {
    this.store = opts.store;
    const creds = opts.creds;
    this.resolveCreds = typeof creds === "function" ? creds : () => creds;
    this.scopes = opts.scopes ?? DEFAULT_SCOPES;
  }

  /** Snapshot the current creds. Re-evaluates the resolver on every call. */
  currentCreds(): GoogleOAuthCreds {
    return this.resolveCreds();
  }

  /** Build a fresh OAuth2Client with the currently-configured app credentials. */
  newOAuthClient(): OAuth2Client {
    const creds = this.resolveCreds();
    return new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
  }

  /** Mint a CSRF state token; consume it once via {@link consumeState}. */
  mintState(): string {
    this.gcStates();
    const token = randomBytes(18).toString("base64url");
    this.stateStore.set(token, { expires: Date.now() + STATE_TTL_MS });
    return token;
  }

  consumeState(token: string): boolean {
    this.gcStates();
    const entry = this.stateStore.get(token);
    if (!entry) return false;
    this.stateStore.delete(token);
    return entry.expires >= Date.now();
  }

  private gcStates(): void {
    const now = Date.now();
    for (const [k, v] of this.stateStore) {
      if (v.expires < now) this.stateStore.delete(k);
    }
  }

  /** Build the Google consent URL for a fresh connect attempt. */
  buildAuthUrl(state: string): string {
    return this.newOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: this.scopes,
      state,
      include_granted_scopes: true,
    });
  }

  /** Exchange an authorization code for tokens + the connected user's email. */
  async exchangeCode(code: string): Promise<{ tokens: Credentials; email: string }> {
    const client = this.newOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data } = await oauth2.userinfo.get();
    return { tokens, email: data.email ?? "unknown@google" };
  }

  /** Persist a freshly-issued token bundle. */
  saveConnection(opts: {
    tokens: Credentials;
    email: string;
    features?: GoogleFeature[];
  }): GoogleAccount {
    return this.store.upsert(opts);
  }

  listAccounts(): GoogleAccount[] {
    return this.store.list();
  }

  /**
   * Hand back an authenticated client for the named feature. Picks the first
   * account that has the feature enabled. Returns null when no such account
   * exists, so callers can degrade rather than throw.
   */
  authedClientFor(feature: GoogleFeature): AuthedClient | null {
    const accounts = this.store.list().filter((a) => a.features.includes(feature));
    const account = accounts[0];
    if (!account) return null;
    return { client: this.makeClient(account), account };
  }

  /** Variant: every account with the feature enabled. */
  allAuthedClientsFor(feature: GoogleFeature): AuthedClient[] {
    return this.store
      .list()
      .filter((a) => a.features.includes(feature))
      .map((account) => ({ client: this.makeClient(account), account }));
  }

  /** Look up an authed client by account id. */
  authedClientById(accountId: string): AuthedClient | null {
    const account = this.store.getById(accountId);
    if (!account) return null;
    return { client: this.makeClient(account), account };
  }

  /** Toggle which features an account exposes. */
  setFeatures(accountId: string, features: GoogleFeature[]): void {
    this.store.setFeatures(accountId, features);
  }

  async disconnect(accountId: string): Promise<void> {
    const account = this.store.getById(accountId);
    if (!account) return;
    try {
      const tokens = this.store.readTokens(accountId);
      const client = this.newOAuthClient();
      client.setCredentials(tokens);
      await client.revokeCredentials();
    } catch {
      // already revoked / network down — fall through and drop the row anyway
    }
    this.store.remove(accountId);
  }

  private makeClient(account: GoogleAccount): OAuth2Client {
    const tokens = this.store.readTokens(account.id);
    const client = this.newOAuthClient();
    client.setCredentials(tokens);
    client.on("tokens", (next) => {
      const merged: Credentials = { ...tokens, ...next };
      if (!merged.refresh_token && tokens.refresh_token) {
        merged.refresh_token = tokens.refresh_token;
      }
      try {
        this.store.writeTokens(account.id, merged);
      } catch (err) {
        console.error("squad/plugin-google-auth: token persist failed", err);
      }
    });
    return client;
  }
}

const GLOBAL_KEY = "__squadGoogleAuth";

interface GlobalSlot {
  [GLOBAL_KEY]?: GoogleAuthService;
}

/**
 * Stash / fetch the singleton service. Other Google plugins look it up here
 * to avoid having to re-thread the instance through plugin config.
 */
export function setSharedGoogleAuth(svc: GoogleAuthService): void {
  (globalThis as GlobalSlot)[GLOBAL_KEY] = svc;
}

export function getSharedGoogleAuth(): GoogleAuthService {
  const svc = (globalThis as GlobalSlot)[GLOBAL_KEY];
  if (!svc) {
    throw new Error(
      "@squad/plugin-google-auth has not been loaded — register it before calendar/gmail/drive plugins",
    );
  }
  return svc;
}

export function tryGetSharedGoogleAuth(): GoogleAuthService | null {
  return (globalThis as GlobalSlot)[GLOBAL_KEY] ?? null;
}
