import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db/index.js";
import {
  ensureMemoryDir,
  deleteEntryFile,
  listEntryFiles,
  readEntryFile,
  slugForEntry,
  uniqueEntryPath,
  writeEntryFile,
  writeIndex,
} from "./files.js";
import {
  EAGER_BLOCK_BUDGET,
  type MemoryEntry,
  type MemoryProposeInput,
  type MemorySearchHit,
  type MemorySearchInput,
  type MemoryStatus,
  type MemoryType,
  type MemoryUpdateInput,
} from "./types.js";
import { defaultScopeForType, validateProposeInput } from "./validate.js";

interface MemoryRow {
  id: string;
  type: MemoryType;
  name: string;
  description: string;
  scope: string;
  scope_key: string | null;
  file_path: string;
  body: string;
  status: MemoryStatus;
  confidence: number;
  provenance_session_id: string | null;
  provenance_agent_id: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    scope: row.scope as MemoryEntry["scope"],
    scopeKey: row.scope_key,
    filePath: row.file_path,
    body: row.body,
    status: row.status,
    confidence: row.confidence,
    provenanceSessionId: row.provenance_session_id,
    provenanceAgentId: row.provenance_agent_id,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DuplicateMatch {
  entry: MemoryEntry;
  score: number;
}

export class DuplicateMemoryError extends Error {
  constructor(public readonly matches: DuplicateMatch[]) {
    super(
      `near-duplicate memory exists; use memory_update on id=${matches[0]?.entry.id ?? "?"} or rename`,
    );
    this.name = "DuplicateMemoryError";
  }
}

export interface MemoryStoreOptions {
  /** Absolute path to ~/.squad/memory (or override). Created if missing. */
  memoryDir: string;
}

/**
 * MemoryStore is the source-of-record for typed memory entries.
 *
 * Design: files on disk are canonical, the DB is a derived index. Every
 * write is file-first, then re-read into the DB; this way concurrent writers
 * can't fight over a row, and the user can edit markdown by hand without
 * the DB drifting (rebuildIndex() picks up disk changes).
 */
export class MemoryStore {
  private readonly memoryDir: string;

  constructor(
    private readonly db: DatabaseHandle,
    opts: MemoryStoreOptions,
  ) {
    this.memoryDir = opts.memoryDir;
    ensureMemoryDir(this.memoryDir);
    this.rebuildIndex();
  }

  get dir(): string {
    return this.memoryDir;
  }

  /** Drop and rebuild the SQLite index from the on-disk markdown files. */
  rebuildIndex(): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_entry; DELETE FROM memory_entry_fts;");
      for (const path of listEntryFiles(this.memoryDir)) {
        try {
          const { frontmatter, body } = readEntryFile(path);
          this.insertRow({
            id: frontmatter.id,
            type: frontmatter.type,
            name: frontmatter.name,
            description: frontmatter.description,
            scope: frontmatter.scope,
            scopeKey: frontmatter.scopeKey ?? null,
            filePath: path,
            body,
            status: frontmatter.status,
            confidence: frontmatter.confidence,
            provenanceSessionId: frontmatter.provenanceSessionId ?? null,
            provenanceAgentId: frontmatter.provenanceAgentId ?? null,
            useCount: 0,
            lastUsedAt: null,
            createdAt: frontmatter.createdAt,
            updatedAt: frontmatter.updatedAt,
          });
        } catch (err) {
          // Bad files are skipped, not fatal — the DB is just an index.
          console.warn(`memory: skipping unparseable entry ${path}: ${(err as Error).message}`);
        }
      }
    });
    tx();
    this.writeIndexFile();
  }

  list(opts: {
    type?: MemoryType;
    scope?: string;
    scopeKey?: string | null;
    status?: MemoryStatus;
  } = {}): MemoryEntry[] {
    let sql = "SELECT * FROM memory_entry WHERE 1=1";
    const args: unknown[] = [];
    if (opts.type) {
      sql += " AND type = ?";
      args.push(opts.type);
    }
    if (opts.scope) {
      sql += " AND scope = ?";
      args.push(opts.scope);
    }
    if (opts.scopeKey !== undefined) {
      if (opts.scopeKey === null) sql += " AND scope_key IS NULL";
      else {
        sql += " AND scope_key = ?";
        args.push(opts.scopeKey);
      }
    }
    if (opts.status) {
      sql += " AND status = ?";
      args.push(opts.status);
    }
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...args) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  get(id: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT * FROM memory_entry WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Create a new entry. Throws MemoryValidationError on bad input,
   * DuplicateMemoryError if an active near-duplicate exists.
   */
  propose(input: MemoryProposeInput): MemoryEntry {
    const v = validateProposeInput(input);
    const dupes = this.findDuplicates(v);
    if (dupes.length > 0) throw new DuplicateMemoryError(dupes);

    const now = new Date().toISOString();
    const id = randomUUID();
    const slug = slugForEntry(v.type, v.name);
    const filePath = uniqueEntryPath(this.memoryDir, slug);
    const scope = v.scope ?? defaultScopeForType(v.type as MemoryType);
    const scopeKey = v.scopeKey ?? null;
    const entry: MemoryEntry = {
      id,
      type: v.type as MemoryType,
      name: v.name,
      description: v.description,
      scope,
      scopeKey,
      filePath,
      body: v.body.trim(),
      status: "active",
      confidence: v.confidence ?? 50,
      provenanceSessionId: v.sessionId ?? null,
      provenanceAgentId: v.agentId ?? null,
      useCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    writeEntryFile(entry);
    this.insertRow(entry);
    this.appendHistory(entry, "create", v.agentId ?? null);
    this.writeIndexFile();
    return entry;
  }

  update(input: MemoryUpdateInput): MemoryEntry {
    const existing = this.get(input.id);
    if (!existing) throw new Error(`memory entry ${input.id} not found`);
    if (existing.status !== "active") {
      throw new Error(`cannot update archived entry ${input.id}; archive again or restore`);
    }
    const next: MemoryEntry = {
      ...existing,
      description: input.description ?? existing.description,
      body: (input.body ?? existing.body).trim(),
      confidence: input.confidence ?? existing.confidence,
      updatedAt: new Date().toISOString(),
    };
    if (next.description.length > 200 || next.description.includes("\n")) {
      throw new Error("description must be a single line, max 200 chars");
    }
    writeEntryFile(next);
    this.replaceRow(next);
    this.appendHistory(next, input.reason ?? "update", input.agentId ?? null);
    this.writeIndexFile();
    return next;
  }

  archive(id: string, opts: { reason?: string; agentId?: string | null } = {}): MemoryEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`memory entry ${id} not found`);
    if (existing.status === "archived") return existing;
    const next: MemoryEntry = {
      ...existing,
      status: "archived",
      updatedAt: new Date().toISOString(),
    };
    writeEntryFile(next);
    this.replaceRow(next);
    this.appendHistory(next, opts.reason ?? "archive", opts.agentId ?? null);
    this.writeIndexFile();
    return next;
  }

  /** Hard-delete an entry — file and index gone. Mostly for tests. */
  hardDelete(id: string): void {
    const existing = this.get(id);
    if (!existing) return;
    deleteEntryFile(existing.filePath);
    this.db.prepare("DELETE FROM memory_entry_fts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memory_entry WHERE id = ?").run(id);
    this.writeIndexFile();
  }

  /**
   * FTS5 search across name + description + body. Returns top-k hits with
   * snippets and bumps `use_count` / `last_used_at` for any returned entries.
   */
  search(input: MemorySearchInput): MemorySearchHit[] {
    const q = sanitizeFtsQuery(input.query);
    if (!q) return [];
    const limit = Math.max(1, Math.min(50, input.limit ?? 6));

    // Match against the FTS table by name, then join back to memory_entry to
    // apply scope/type/status filters. We use bm25() (lower is better) so we
    // negate to get an "ascending = better" score.
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memory_entry_fts) AS rank,
                snippet(memory_entry_fts, 3, '«', '»', '…', 16) AS snippet
         FROM memory_entry_fts
         JOIN memory_entry m ON m.id = memory_entry_fts.id
         WHERE memory_entry_fts MATCH ?
         ORDER BY rank ASC
         LIMIT 200`,
      )
      .all(q) as Array<MemoryRow & { rank: number; snippet: string }>;

    const filtered = rows.filter((r) => {
      if (!input.includeArchived && r.status !== "active") return false;
      if (input.types && !input.types.includes(r.type)) return false;
      if (input.scopes && !input.scopes.includes(r.scope as MemoryEntry["scope"])) return false;
      if (input.scopeKey !== undefined) {
        if (input.scopeKey === null && r.scope_key !== null) return false;
        if (input.scopeKey !== null && r.scope_key !== input.scopeKey) return false;
      }
      return true;
    });

    const top = filtered.slice(0, limit).map((r) => ({
      entry: rowToEntry(r),
      score: -r.rank,
      snippet: r.snippet,
    }));

    if (top.length > 0) {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(
        "UPDATE memory_entry SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      const tx = this.db.transaction(() => {
        for (const hit of top) stmt.run(now, hit.entry.id);
      });
      tx();
    }
    return top;
  }

  /**
   * Pick the eager block: every active `user` and `feedback` entry up to a
   * total character budget. Newer + higher-confidence wins on tie. Returns
   * the entries chosen, in render order.
   */
  pickEagerBlock(): MemoryEntry[] {
    const eager = this.list({ status: "active" }).filter(
      (e) => e.type === "user" || e.type === "feedback",
    );
    eager.sort((a, b) => {
      // user before feedback, then higher confidence, then most recent
      if (a.type !== b.type) return a.type === "user" ? -1 : 1;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    let remaining = EAGER_BLOCK_BUDGET;
    const picked: MemoryEntry[] = [];
    for (const e of eager) {
      const cost = e.description.length + e.body.length + e.name.length + 32;
      if (cost > remaining) continue;
      picked.push(e);
      remaining -= cost;
    }
    return picked;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private findDuplicates(input: MemoryProposeInput): DuplicateMatch[] {
    // Exact-name collision within the same type is the high-confidence
    // guardrail. Near-duplicates by content are surfaced via memory_search;
    // the agent prompt instructs "search before you propose," and an
    // FTS-rank heuristic produces too many false positives on short bodies.
    const sameName = this.db
      .prepare(
        "SELECT * FROM memory_entry WHERE type = ? AND name = ? AND status = 'active'",
      )
      .all(input.type, input.name) as MemoryRow[];
    if (sameName.length > 0) {
      return sameName.map((row) => ({ entry: rowToEntry(row), score: 1 }));
    }
    return [];
  }

  private insertRow(entry: MemoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO memory_entry (
          id, type, name, description, scope, scope_key, file_path, body, status,
          confidence, provenance_session_id, provenance_agent_id,
          use_count, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.type,
        entry.name,
        entry.description,
        entry.scope,
        entry.scopeKey,
        entry.filePath,
        entry.body,
        entry.status,
        entry.confidence,
        entry.provenanceSessionId,
        entry.provenanceAgentId,
        entry.useCount,
        entry.lastUsedAt,
        entry.createdAt,
        entry.updatedAt,
      );
    this.db
      .prepare("INSERT INTO memory_entry_fts (id, name, description, body) VALUES (?, ?, ?, ?)")
      .run(entry.id, entry.name, entry.description, entry.body);
  }

  private replaceRow(entry: MemoryEntry): void {
    this.db.prepare("DELETE FROM memory_entry_fts WHERE id = ?").run(entry.id);
    this.db
      .prepare(
        `UPDATE memory_entry SET
          type = ?, name = ?, description = ?, scope = ?, scope_key = ?, file_path = ?,
          body = ?, status = ?, confidence = ?,
          provenance_session_id = ?, provenance_agent_id = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        entry.type,
        entry.name,
        entry.description,
        entry.scope,
        entry.scopeKey,
        entry.filePath,
        entry.body,
        entry.status,
        entry.confidence,
        entry.provenanceSessionId,
        entry.provenanceAgentId,
        entry.updatedAt,
        entry.id,
      );
    this.db
      .prepare("INSERT INTO memory_entry_fts (id, name, description, body) VALUES (?, ?, ?, ?)")
      .run(entry.id, entry.name, entry.description, entry.body);
  }

  private appendHistory(entry: MemoryEntry, reason: string, agentId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO memory_history (id, entry_id, body, description, reason, changed_by_agent_id, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        entry.id,
        entry.body,
        entry.description,
        reason,
        agentId,
        new Date().toISOString(),
      );
  }

  private writeIndexFile(): void {
    writeIndex(this.memoryDir, this.list());
  }
}

/**
 * Sanitize a free-text query for FTS5: strip operators that would otherwise
 * raise SqliteError, drop stop chars, fall back to phrase-quoted form so that
 * near-duplicate input strings still match.
 */
export function sanitizeFtsQuery(raw: string): string {
  if (!raw) return "";
  // Tokenize to alphanumerics; FTS5 operators (AND, OR, NOT, NEAR, MATCH,
  // ", :, *, ()) are dropped. Each surviving term becomes a prefix match so
  // that partial matches surface near-dupes.
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2 && !FTS_RESERVED.has(t))
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}*`).join(" OR ");
}

const FTS_RESERVED = new Set(["and", "or", "not", "near", "match"]);
