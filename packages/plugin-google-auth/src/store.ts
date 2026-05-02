import Database, { type Database as SqliteDb } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Credentials } from "google-auth-library";
import { makeCipher } from "./crypto.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS google_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tokens_encrypted TEXT NOT NULL,
  features TEXT NOT NULL DEFAULT '["calendar","gmail","drive"]',
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_accounts_email
  ON google_accounts(email);
`;

export type GoogleFeature = "calendar" | "gmail" | "drive";
export const ALL_FEATURES: GoogleFeature[] = ["calendar", "gmail", "drive"];

export interface GoogleAccount {
  id: string;
  email: string;
  features: GoogleFeature[];
  connectedAt: string;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  email: string;
  tokens_encrypted: string;
  features: string;
  connected_at: string;
  updated_at: string;
}

/**
 * Persistent token store for connected Google accounts. Uses a sqlite file
 * separate from the gateway's main DB so the plugin can be enabled without
 * stamping a migration into squad core.
 *
 * Row identity is the account id (`ga_<random>`) — one row per Google
 * account. Multiple accounts per host are supported; consumers that only
 * need one can call `firstAccount()`.
 */
export class GoogleAuthStore {
  private readonly db: SqliteDb;
  private readonly cipher: ReturnType<typeof makeCipher>;

  constructor(opts: { dbPath: string; encryptionKey: string }) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.cipher = makeCipher(opts.encryptionKey);
  }

  upsert(opts: {
    email: string;
    tokens: Credentials;
    features?: GoogleFeature[];
  }): GoogleAccount {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare<[string], AccountRow>(
        `SELECT * FROM google_accounts WHERE email = ?`,
      )
      .get(opts.email);

    // If we have an existing row and the new token bundle has no
    // refresh_token, carry forward the previous one — Google only emits a
    // refresh_token on the first consent (or when prompt=consent forces it).
    const mergedTokens: Credentials = { ...opts.tokens };
    if (existing && !mergedTokens.refresh_token) {
      try {
        const prev = JSON.parse(this.cipher.decrypt(existing.tokens_encrypted)) as Credentials;
        if (prev.refresh_token) mergedTokens.refresh_token = prev.refresh_token;
      } catch {
        // ignore decrypt failures — the encryption key may have rotated
      }
    }

    const tokensEncrypted = this.cipher.encrypt(JSON.stringify(mergedTokens));
    const features = opts.features ?? (existing ? parseFeatures(existing.features) : ALL_FEATURES);
    const featuresJson = JSON.stringify(features);

    if (existing) {
      this.db
        .prepare(
          `UPDATE google_accounts SET tokens_encrypted = ?, features = ?, updated_at = ? WHERE id = ?`,
        )
        .run(tokensEncrypted, featuresJson, now, existing.id);
      return {
        id: existing.id,
        email: opts.email,
        features,
        connectedAt: existing.connected_at,
        updatedAt: now,
      };
    }
    const id = `ga_${randomId()}`;
    this.db
      .prepare(
        `INSERT INTO google_accounts (id, email, tokens_encrypted, features, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.email, tokensEncrypted, featuresJson, now, now);
    return { id, email: opts.email, features, connectedAt: now, updatedAt: now };
  }

  list(): GoogleAccount[] {
    const rows = this.db
      .prepare<[], AccountRow>(`SELECT * FROM google_accounts ORDER BY connected_at ASC`)
      .all();
    return rows.map(rowToAccount);
  }

  firstAccount(): GoogleAccount | null {
    const row = this.db
      .prepare<[], AccountRow>(`SELECT * FROM google_accounts ORDER BY connected_at ASC LIMIT 1`)
      .get();
    return row ? rowToAccount(row) : null;
  }

  getById(id: string): GoogleAccount | null {
    const row = this.db
      .prepare<[string], AccountRow>(`SELECT * FROM google_accounts WHERE id = ?`)
      .get(id);
    return row ? rowToAccount(row) : null;
  }

  getByEmail(email: string): GoogleAccount | null {
    const row = this.db
      .prepare<[string], AccountRow>(`SELECT * FROM google_accounts WHERE email = ?`)
      .get(email);
    return row ? rowToAccount(row) : null;
  }

  /** Decrypt and return raw tokens for an account. Throws if the row is missing. */
  readTokens(id: string): Credentials {
    const row = this.db
      .prepare<[string], AccountRow>(`SELECT * FROM google_accounts WHERE id = ?`)
      .get(id);
    if (!row) throw new Error(`google account ${id} not found`);
    return JSON.parse(this.cipher.decrypt(row.tokens_encrypted)) as Credentials;
  }

  /** Replace the stored tokens for an account (e.g. after a refresh). */
  writeTokens(id: string, tokens: Credentials): void {
    const now = new Date().toISOString();
    const blob = this.cipher.encrypt(JSON.stringify(tokens));
    this.db
      .prepare(`UPDATE google_accounts SET tokens_encrypted = ?, updated_at = ? WHERE id = ?`)
      .run(blob, now, id);
  }

  setFeatures(id: string, features: GoogleFeature[]): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE google_accounts SET features = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(features), now, id);
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM google_accounts WHERE id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}

function rowToAccount(row: AccountRow): GoogleAccount {
  return {
    id: row.id,
    email: row.email,
    features: parseFeatures(row.features),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

function parseFeatures(raw: string): GoogleFeature[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ALL_FEATURES;
    const out: GoogleFeature[] = [];
    for (const v of parsed) {
      if (v === "calendar" || v === "gmail" || v === "drive") out.push(v);
    }
    return out;
  } catch {
    return ALL_FEATURES;
  }
}

function randomId(): string {
  // 12 url-safe characters, ~72 bits — plenty for an account id.
  return Math.random().toString(36).slice(2, 14).padEnd(12, "0");
}
