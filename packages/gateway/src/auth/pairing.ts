import { randomBytes, randomUUID } from "node:crypto";
import type { Authenticator } from "../auth.js";
import type { PairingPersistence, PersistedPairing } from "./pairing-persist.js";

export type PairingStatus = "pending" | "approved" | "claimed" | "expired" | "cancelled";

export interface PendingPairing {
  code: string;
  label: string;
  scopes: string[];
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  claimedAt: string | null;
  /** Set after approve(); cleared on the first successful poll. */
  token: string | null;
  /** Operator label that approved the pairing — surfaced for `pair list`. */
  approvedBy: string | null;
  /** The minted runtime secret. Held alongside `token` so persistence
   *  can write it back even after the browser claims and we clear `token`. */
  secret: string | null;
}

export interface PairingPublicView {
  code: string;
  label: string;
  scopes: string[];
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** Set when the browser has polled and consumed the token. Null otherwise. */
  claimedAt: string | null;
  /** True when the pairing is persisted to disk and survives a gateway restart. */
  persistent: boolean;
}

export interface PairingStoreOptions {
  /** Code lifetime in milliseconds. Defaults to 10 minutes. */
  ttlMs?: number;
  /** Length of the random portion of each code (in 5-char groups). Default 2 → "ABCDE-FGHIJ". */
  groups?: number;
  /** Override for time. Tests inject a fake clock. */
  now?: () => number;
  /**
   * Optional disk-backed persistence. When provided, every approved
   * pairing (and the runtime token it minted) is written through to the
   * persistence layer; the store hydrates from disk in `load()`. Survives
   * gateway restarts so a browser doesn't have to re-pair after every
   * `squad restart`.
   */
  persistence?: PairingPersistence;
}

export interface PairingStoreCallbacks {
  onRequested?: (p: PairingPublicView) => void;
  onApproved?: (p: PairingPublicView) => void;
  onCancelled?: (p: PairingPublicView) => void;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_GROUPS = 2;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit confusable I,O,0,1

/**
 * In-memory short-code store powering browser pairing. Browser hits
 * `begin()` (unauthenticated) and gets back a short code. An operator
 * with CLI access calls `approve()` (authenticated) to mint a per-browser
 * token. The browser polls `claim()` and gets the token exactly once.
 *
 * Codes are random and have a TTL — pending entries are pruned on every
 * mutating call so memory doesn't grow.
 */
export class PairingStore {
  private readonly entries: Map<string, PendingPairing> = new Map();
  private readonly ttlMs: number;
  private readonly groups: number;
  private readonly now: () => number;
  private readonly persistence: PairingPersistence | null;

  constructor(
    private readonly authenticator: Authenticator,
    private readonly cb: PairingStoreCallbacks = {},
    opts: PairingStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.groups = opts.groups ?? DEFAULT_GROUPS;
    this.now = opts.now ?? Date.now;
    this.persistence = opts.persistence ?? null;
  }

  /**
   * Hydrate persisted pairings (called once at boot). For each saved
   * record, re-register the runtime token with the Authenticator so
   * connecting browsers transparently resume their session, and seed
   * the in-memory entry table so cancel/list work as expected.
   */
  hydrate(): number {
    if (!this.persistence) return 0;
    const saved = this.persistence.load();
    let n = 0;
    for (const r of saved) {
      // The Authenticator is the source of truth for live tokens; PendingPairing
      // is just metadata. A persisted pairing is *always* claimed: the
      // browser has already consumed it (or is about to).
      this.authenticator.addRuntimeToken({ label: r.label, secret: r.secret, scopes: r.scopes });
      this.entries.set(r.code, {
        code: r.code,
        label: r.label,
        scopes: r.scopes,
        status: "claimed",
        createdAt: r.createdAt,
        expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
        approvedAt: r.approvedAt,
        claimedAt: r.claimedAt,
        token: null, // already handed out; secret lives only in Authenticator + on disk
        approvedBy: r.approvedBy,
        secret: r.secret,
      });
      n += 1;
    }
    return n;
  }

  /**
   * Create a new pending pairing and return the public-facing record (no
   * token). The browser shows the user the code and tells them to approve
   * it from the CLI.
   */
  begin(input: { label?: string; scopes?: string[] } = {}): PairingPublicView {
    this.prune();
    const code = this.freshCode();
    const created = this.now();
    const entry: PendingPairing = {
      code,
      label: input.label?.trim() || `browser-${code.split("-").join("")}`,
      scopes: input.scopes && input.scopes.length > 0 ? [...input.scopes] : ["*"],
      status: "pending",
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttlMs).toISOString(),
      approvedAt: null,
      claimedAt: null,
      token: null,
      approvedBy: null,
      secret: null,
    };
    this.entries.set(code, entry);
    const view = this.publicView(entry);
    this.cb.onRequested?.(view);
    return view;
  }

  /**
   * Approve a pending pairing. Mints a runtime token via the
   * Authenticator and stores it on the pairing. The browser receives it
   * via `claim()`. Returns the public view, throws on unknown/expired.
   */
  approve(input: { code: string; approvedBy?: string }): PairingPublicView {
    this.prune();
    const entry = this.entries.get(normalizeCode(input.code));
    if (!entry) throw new Error("unknown pairing code");
    if (entry.status === "expired") throw new Error("pairing code expired");
    if (entry.status === "cancelled") throw new Error("pairing code cancelled");
    if (entry.status === "claimed") throw new Error("pairing already used");
    if (entry.status === "approved") {
      // Idempotent re-approval — return the existing view.
      return this.publicView(entry);
    }
    const secret = "pair_" + randomUUID().replace(/-/g, "");
    this.authenticator.addRuntimeToken({ label: entry.label, secret, scopes: entry.scopes });
    entry.token = secret;
    entry.secret = secret;
    entry.status = "approved";
    entry.approvedAt = new Date(this.now()).toISOString();
    entry.approvedBy = input.approvedBy ?? null;
    this.persist(entry);
    const view = this.publicView(entry);
    this.cb.onApproved?.(view);
    return view;
  }

  /**
   * Browser-side poll. Returns the current status; on the first call after
   * approval, returns the token and marks the pairing claimed (so the same
   * code can't extract two tokens). Subsequent calls return "claimed".
   */
  claim(code: string): { status: PairingStatus; token?: string; label?: string; expiresAt?: string } {
    this.prune();
    const entry = this.entries.get(normalizeCode(code));
    if (!entry) return { status: "expired" };
    if (entry.status === "approved" && entry.token) {
      const token = entry.token;
      entry.token = null;
      entry.status = "claimed";
      entry.claimedAt = new Date(this.now()).toISOString();
      this.persist(entry);
      return { status: "approved", token, label: entry.label, expiresAt: entry.expiresAt };
    }
    return { status: entry.status };
  }

  cancel(code: string): PairingPublicView | null {
    this.prune();
    const entry = this.entries.get(normalizeCode(code));
    if (!entry) return null;
    // Revoke the runtime token wherever it lives (held in `token` if not yet
    // claimed, or only on `secret` after claim).
    const liveSecret = entry.token ?? entry.secret;
    if (liveSecret) this.authenticator.removeToken(liveSecret);
    entry.status = "cancelled";
    entry.token = null;
    entry.secret = null;
    this.persistence?.remove(entry.code);
    const view = this.publicView(entry);
    this.cb.onCancelled?.(view);
    return view;
  }

  list(): PairingPublicView[] {
    this.prune();
    // Include `claimed` entries — these are the *active* browser sessions
    // (token is in the Authenticator). The Settings UI shows these so the
    // operator can revoke a browser from the dashboard.
    return Array.from(this.entries.values()).map((e) => this.publicView(e));
  }

  private prune(): void {
    const now = this.now();
    for (const [code, entry] of this.entries) {
      if (entry.status === "claimed") {
        // Persisted: never auto-evict. The token in the Authenticator stays
        // live until the operator cancels it.
        continue;
      }
      if (entry.status === "cancelled") {
        const since = Date.parse(entry.claimedAt ?? entry.createdAt);
        if (now - since > this.ttlMs) this.entries.delete(code);
        continue;
      }
      if (now > Date.parse(entry.expiresAt)) {
        if (entry.token) this.authenticator.removeToken(entry.token);
        entry.token = null;
        entry.secret = null;
        entry.status = "expired";
      }
    }
  }

  private persist(entry: PendingPairing): void {
    if (!this.persistence) return;
    if (!entry.secret || !entry.approvedAt) return;
    const record: PersistedPairing = {
      code: entry.code,
      label: entry.label,
      scopes: entry.scopes,
      secret: entry.secret,
      createdAt: entry.createdAt,
      approvedAt: entry.approvedAt,
      approvedBy: entry.approvedBy,
      claimedAt: entry.claimedAt,
    };
    this.persistence.upsert(record);
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode(this.groups);
      if (!this.entries.has(code)) return code;
    }
    // Astronomically unlikely; bail rather than loop forever.
    throw new Error("could not allocate a unique pairing code");
  }

  private publicView(entry: PendingPairing): PairingPublicView {
    return {
      code: entry.code,
      label: entry.label,
      scopes: entry.scopes,
      status: entry.status,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      approvedAt: entry.approvedAt,
      approvedBy: entry.approvedBy,
      claimedAt: entry.claimedAt,
      persistent: this.persistence !== null && entry.secret !== null,
    };
  }
}

function randomCode(groups: number): string {
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let group = "";
    const buf = randomBytes(5);
    for (let i = 0; i < 5; i++) {
      group += ALPHABET[buf[i]! % ALPHABET.length];
    }
    out.push(group);
  }
  return out.join("-");
}

function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9-]/g, "");
}
