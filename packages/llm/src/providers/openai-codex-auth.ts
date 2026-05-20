/**
 * CodexAuth — refresh-token-backed credential manager for the Codex
 * (ChatGPT subscription) provider.
 *
 * Bootstrap: the gateway hands this class a refresh token (sourced from
 * an env var or config). The first access token is minted via the
 * /oauth/token endpoint. Subsequent calls reuse the cached access token
 * until it nears expiry, at which point the next `getAccessToken()`
 * triggers a single deduped refresh.
 *
 * Persistence: the most recent credentials blob is written to a JSON
 * file inside the gateway's `data_dir` so a container restart doesn't
 * always hit the refresh endpoint. This file is intentionally separate
 * from `~/.codex/auth.json` — squad must be able to authenticate as a
 * *different* ChatGPT account than whatever the host user is logged into.
 *
 * The file holds:
 *   {
 *     "access":     "<jwt>",
 *     "refresh":    "<refresh token, may rotate>",
 *     "expires":    <unix ms>,
 *     "accountId":  "<chatgpt account uuid>"
 *   }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  refreshOpenAICodexToken,
  getAccountIdFromJwt,
  getExpiryFromJwt,
  type CodexCredentials,
  CodexAuthError,
} from "../oauth/openai-codex-login.js";

/** Refresh this many ms before the access token's `exp` to avoid races. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface CodexAuthOptions {
  /**
   * Absolute path to the JSON credentials file. The directory is created
   * 0700 if missing; the file is written 0600. Required — there is no
   * default, so callers must decide where in the data dir the file lives.
   */
  credsPath: string;
  /**
   * Refresh token supplied at boot (typically from env var or config).
   * When provided, takes precedence over any refresh token in the existing
   * credentials file — lets operators rotate the secret without first
   * deleting the cached state.
   */
  refreshToken?: string;
}

export class CodexAuthService {
  readonly credsPath: string;
  private credentials: CodexCredentials | null = null;
  /** Refresh token override supplied at construction time, if any. */
  private readonly bootRefresh: string | undefined;
  /** In-flight refresh promise — dedups concurrent callers. */
  private refreshPromise: Promise<void> | null = null;

  constructor(opts: CodexAuthOptions) {
    this.credsPath = opts.credsPath;
    this.bootRefresh = opts.refreshToken;
    this.load();
  }

  /**
   * Return a valid access token, refreshing when within the buffer window.
   * Throws if neither a refresh token nor a valid cached access token is
   * available.
   */
  async getAccessToken(): Promise<string> {
    if (this.credentials && !this.isNearExpiry(this.credentials.expires)) {
      return this.credentials.access;
    }
    await this.refresh();
    if (!this.credentials) {
      throw new CodexAuthError(
        "No Codex credentials available — set refresh_token / refresh_token_env in providers.openai-codex.",
      );
    }
    return this.credentials.access;
  }

  /** Synchronous read of the cached access token, ignoring expiry. */
  getCachedCredentials(): CodexCredentials | null {
    return this.credentials;
  }

  /** Whether a refresh token is on file. */
  hasCredentials(): boolean {
    return Boolean(this.credentials?.refresh ?? this.bootRefresh);
  }

  /** ChatGPT-Account-Id for the cached creds, decoded lazily from the JWT. */
  getAccountId(): string | undefined {
    if (this.credentials?.accountId) return this.credentials.accountId;
    if (this.credentials?.access) {
      const id = getAccountIdFromJwt(this.credentials.access);
      return id ?? undefined;
    }
    return undefined;
  }

  /**
   * Force a refresh now. Called by the client when a request comes back
   * 401 even though the cached access token claimed to still be valid —
   * which happens when the server has invalidated the token early.
   */
  async forceRefresh(): Promise<void> {
    await this.refresh();
  }

  private isNearExpiry(expires: number): boolean {
    return Date.now() >= expires - REFRESH_BUFFER_MS;
  }

  private refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    // The boot-supplied refresh token always wins. This lets operators
    // rotate the secret by updating the env var + restarting; the cached
    // file's refresh token is then ignored.
    const refresh = this.bootRefresh ?? this.credentials?.refresh;
    if (!refresh) {
      throw new CodexAuthError(
        "Cannot refresh Codex token: no refresh_token supplied via env/config and no cached credentials.",
      );
    }
    const next = await refreshOpenAICodexToken(refresh);
    this.credentials = next;
    this.persist(next);
  }

  /** Read the creds file from disk, if present. Silently ignores corruption. */
  private load(): void {
    if (!existsSync(this.credsPath)) return;
    try {
      const raw = readFileSync(this.credsPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CodexCredentials>;
      if (
        typeof parsed.access !== "string" ||
        typeof parsed.refresh !== "string" ||
        typeof parsed.expires !== "number"
      ) {
        return;
      }
      // If the persisted file is from a previous build that didn't decode
      // the account id, fill it in now so the first request gets the
      // correct header.
      const accountId =
        parsed.accountId ?? getAccountIdFromJwt(parsed.access) ?? undefined;
      // Trust `exp` in the JWT over the persisted `expires` field — the
      // latter races slightly with the actual server-side expiry, and a
      // stale expires would lead to surprise 401s on the first request.
      const jwtExpiry = getExpiryFromJwt(parsed.access);
      this.credentials = {
        access: parsed.access,
        refresh: parsed.refresh,
        expires: jwtExpiry ?? parsed.expires,
        ...(accountId !== undefined ? { accountId } : {}),
      };
    } catch {
      /* corrupt file — fall through to a fresh refresh on first request */
    }
  }

  private persist(creds: CodexCredentials): void {
    try {
      const dir = dirname(this.credsPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.credsPath, JSON.stringify(creds, null, 2), "utf-8");
      try {
        chmodSync(this.credsPath, 0o600);
      } catch {
        /* best-effort — Windows / non-POSIX filesystems just won't honour this */
      }
    } catch (err) {
      // Persistence failure isn't fatal — the in-memory token still works
      // for the rest of this process's lifetime. Log to stderr so an
      // operator notices the writable-volume mistake.
      process.stderr.write(
        `codex-auth: failed to persist credentials to ${this.credsPath}: ${(err as Error).message}\n`,
      );
    }
  }
}
