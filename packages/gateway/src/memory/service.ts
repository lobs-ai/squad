/**
 * MemoryService — squad's typed-memory contract on top of MemCore.
 *
 * Squad exposes a typed-scope model (user / feedback / project / reference /
 * working) with explicit propose / update / archive operations. MemCore
 * stores atomic memories with categories and a JSONB metadata blob. This
 * service translates: every typed entry becomes one MemCore memory written
 * via the direct-add path (`extract: false`), with squad's typed metadata
 * carried in `metadata`. Search / list / get / archive route through
 * MemCore directly — no SQLite, no markdown files.
 *
 * The MemoryEntry id is the MemCore row id, so callers (the agent's
 * memory_update / memory_archive tools) reference MemCore rows directly.
 */

import type {
  FindSimilarArgs,
  ListMemoriesArgs as MemCoreListArgs,
  MemCore,
  MemoryRow,
  MemoryStatus as MemCoreStatus,
  SearchArgs,
  SimilarMemoryHit,
} from "memcore";
import type { Logger } from "pino";
import type { PromptMemoryEntry, PromptMemoryHit } from "../agent-prompt.js";
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

const DUPLICATE_THRESHOLD = 0.92;

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

export interface MemoryServiceOptions {
  containerTag?: string;
  /** Eager-block char budget. Defaults to EAGER_BLOCK_BUDGET. */
  eagerBudget?: number;
  /**
   * When set, every successful write/update/archive mirrors the entry as a
   * `<dataDir>/memory/<id>.md` file with frontmatter metadata. Best-effort —
   * mirror failures don't block the DB write. Tests typically omit this.
   */
  markdownMirror?: import("./markdown-mirror.js").MarkdownMemoryMirror;
}

export class MemoryService {
  private readonly containerTag: string;
  private readonly eagerBudget: number;
  private readonly eagerCache = new Map<string, PromptMemoryEntry[]>();
  private readonly markdownMirror: import("./markdown-mirror.js").MarkdownMemoryMirror | undefined;

  constructor(
    private readonly memcore: MemCore,
    private readonly logger: Logger,
    opts: MemoryServiceOptions = {},
  ) {
    this.containerTag = opts.containerTag ?? "squad";
    this.eagerBudget = opts.eagerBudget ?? EAGER_BLOCK_BUDGET;
    this.markdownMirror = opts.markdownMirror;
  }

  // ── Write path ────────────────────────────────────────────────────────

  async propose(input: MemoryProposeInput): Promise<MemoryEntry> {
    const v = validateProposeInput(input);
    const scope = v.scope ?? defaultScopeForType(v.type);
    const content = renderContent({ name: v.name, description: v.description, body: v.body });

    // Pre-write dedup against this container.
    const dupes = await this.memcore.findSimilar({
      containerTag: this.containerTag,
      content,
      threshold: DUPLICATE_THRESHOLD,
      limit: 3,
      statuses: ["active"],
    });
    const sameNameDupes = dupes.filter((d) => {
      const meta = d.metadata as Record<string, unknown> | undefined;
      return d.category === v.type && meta?.name === v.name;
    });
    if (sameNameDupes.length > 0) {
      throw new DuplicateMemoryError(
        sameNameDupes.map((d) => ({
          entry: this.similarHitToEntry(d),
          score: d.similarity,
        })),
      );
    }

    const result = await this.memcore.add({
      containerTag: this.containerTag,
      content,
      extract: false,
      category: v.type,
      confidence: v.confidence ?? 0.5,
      metadata: this.buildMetadata({
        name: v.name,
        description: v.description,
        body: v.body,
        scope,
        scopeKey: v.scopeKey ?? null,
        status: "active",
        provenanceSessionId: v.sessionId ?? null,
        provenanceAgentId: v.agentId ?? null,
      }),
    });
    const id = result.memories?.[0]?.id;
    if (!id) throw new Error("memcore.add returned no memory id");
    const row = await this.memcore.get({ containerTag: this.containerTag, id });
    if (!row) throw new Error(`memcore.add wrote id=${id} but get() returned null`);
    const entry = this.rowToEntry(row);
    this.markdownMirror?.upsert(entry);
    return entry;
  }

  async update(input: MemoryUpdateInput): Promise<MemoryEntry> {
    const existing = await this.get(input.id);
    if (!existing) throw new Error(`memory entry ${input.id} not found`);
    if (existing.status !== "active") {
      throw new Error(`cannot update archived entry ${input.id}; archive again or restore`);
    }
    const nextDescription = input.description ?? existing.description;
    if (nextDescription.length > 200 || nextDescription.includes("\n")) {
      throw new Error("description must be a single line, max 200 chars");
    }
    const nextBody = (input.body ?? existing.body).trim();
    const content = renderContent({
      name: existing.name,
      description: nextDescription,
      body: nextBody,
    });
    const nextConfidence = input.confidence ?? existing.confidence;
    const updated = await this.memcore.update({
      containerTag: this.containerTag,
      id: input.id,
      content,
      category: existing.type,
      confidence: nextConfidence,
      metadata: this.buildMetadata({
        name: existing.name,
        description: nextDescription,
        body: nextBody,
        scope: existing.scope,
        scopeKey: existing.scopeKey,
        status: existing.status,
        provenanceSessionId: existing.provenanceSessionId,
        provenanceAgentId: input.agentId ?? existing.provenanceAgentId,
      }),
    });
    const entry = this.rowToEntry(updated);
    this.markdownMirror?.upsert(entry);
    return entry;
  }

  async archive(
    id: string,
    _opts: { reason?: string; agentId?: string | null } = {},
  ): Promise<MemoryEntry> {
    const row = await this.memcore.archive({ containerTag: this.containerTag, id });
    this.markdownMirror?.remove(id);
    return this.rowToEntry(row);
  }

  /**
   * Mirror a batch of memcore-written memory rows to disk. Used by the
   * session ingestion pipeline after `memcore.add({extract:true})` — that
   * path bypasses `propose()` (no typed metadata, no dedup) but the
   * extracted memories still need to land as `.md` files so users can
   * read/grep them. No-op when the mirror isn't configured. Best-effort:
   * a missing row or a mirror write error is logged, never thrown — the
   * memcore DB row is the source of truth.
   */
  async mirrorMemoriesByIds(ids: readonly string[]): Promise<void> {
    if (!this.markdownMirror || ids.length === 0) return;
    for (const id of ids) {
      try {
        const entry = await this.get(id);
        if (!entry) {
          this.logger.warn({ id }, "mirrorMemoriesByIds: row not found");
          continue;
        }
        this.markdownMirror.upsert(entry);
      } catch (err) {
        this.logger.warn({ err, id }, "mirrorMemoriesByIds: per-id mirror failed");
      }
    }
  }

  /** Absolute path of the markdown mirror dir, or null when not configured. */
  getMirrorDir(): string | null {
    return this.markdownMirror?.getDir() ?? null;
  }

  // ── Read path ─────────────────────────────────────────────────────────

  async get(id: string): Promise<MemoryEntry | null> {
    const row = await this.memcore.get({ containerTag: this.containerTag, id });
    return row ? this.rowToEntry(row) : null;
  }

  async list(opts: {
    type?: MemoryType;
    scope?: string;
    scopeKey?: string | null;
    status?: MemoryStatus;
  } = {}): Promise<MemoryEntry[]> {
    const args: MemCoreListArgs = {
      containerTag: this.containerTag,
      sort: "recency",
    };
    const metadata: Record<string, unknown> = {};
    if (opts.scope) metadata.scope = opts.scope;
    if (opts.scopeKey !== undefined && opts.scopeKey !== null) metadata.scopeKey = opts.scopeKey;
    const filters: NonNullable<MemCoreListArgs["filters"]> = {};
    if (opts.type) filters.categories = [opts.type];
    if (Object.keys(metadata).length > 0) filters.metadata = metadata;
    if (opts.status) filters.status = opts.status as MemCoreStatus;
    if (Object.keys(filters).length > 0) args.filters = filters;
    const rows = await this.memcore.list(args);
    let entries = rows.map((r) => this.rowToEntry(r));
    if (opts.scopeKey === null) {
      entries = entries.filter((e) => e.scopeKey === null);
    }
    return entries;
  }

  async search(input: MemorySearchInput): Promise<MemorySearchHit[]> {
    const limit = Math.max(1, Math.min(50, input.limit ?? 6));
    const args: SearchArgs = {
      containerTag: this.containerTag,
      query: input.query,
      limit,
      includeChunks: false,
      includeProfile: false,
    };
    const filters: NonNullable<SearchArgs["filters"]> = {
      status: input.includeArchived ? ["active", "archived"] : "active",
    };
    if (input.types && input.types.length > 0) filters.categories = [...input.types];
    args.filters = filters;
    const response = await this.memcore.search(args);
    const hits: MemorySearchHit[] = [];
    for (const result of response.results) {
      const entry = this.rowToEntry(result.memory);
      if (input.types && !input.types.includes(entry.type)) continue;
      if (input.scopes && !input.scopes.includes(entry.scope)) continue;
      if (input.scopeKey !== undefined) {
        if (input.scopeKey === null && entry.scopeKey !== null) continue;
        if (input.scopeKey !== null && entry.scopeKey !== input.scopeKey) continue;
      }
      hits.push({
        entry,
        score: result.score,
        snippet: snippetOf(result.memory.content),
      });
    }
    return hits;
  }

  // ── Prompt-builder helpers ────────────────────────────────────────────

  /**
   * Eager block: every active `user` and `feedback` entry, packed into
   * EAGER_BLOCK_BUDGET chars. Frozen per session — first call snapshots,
   * subsequent calls return the cached snapshot until invalidated.
   */
  async eagerForSession(sessionId: string): Promise<PromptMemoryEntry[]> {
    const cached = this.eagerCache.get(sessionId);
    if (cached) return cached;
    const [users, feedback] = await Promise.all([
      this.list({ type: "user", status: "active" }),
      this.list({ type: "feedback", status: "active" }),
    ]);
    const all = [...users, ...feedback];
    all.sort((a, b) => {
      if (a.type !== b.type) return a.type === "user" ? -1 : 1;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    let remaining = this.eagerBudget;
    const picked: MemoryEntry[] = [];
    for (const e of all) {
      const cost = e.description.length + e.body.length + e.name.length + 32;
      if (cost > remaining) continue;
      picked.push(e);
      remaining -= cost;
    }
    const snapshot = picked.map(toPromptEntry);
    this.eagerCache.set(sessionId, snapshot);
    return snapshot;
  }

  invalidateSession(sessionId: string): void {
    this.eagerCache.delete(sessionId);
  }

  /**
   * Per-turn retrieval: semantic search over project + reference entries
   * scoped to this tree. Empty for too-short queries.
   */
  async retrievalForTurn(
    query: string,
    opts: { scopeKey?: string | null; limit?: number } = {},
  ): Promise<PromptMemoryHit[]> {
    if (!query || query.trim().length < 4) return [];
    const hits = await this.search({
      query,
      types: ["project", "reference"],
      ...(opts.scopeKey !== undefined ? { scopeKey: opts.scopeKey } : {}),
      limit: opts.limit ?? 4,
    });
    return hits.map((h) => ({
      id: h.entry.id,
      type: h.entry.type,
      name: h.entry.name,
      description: h.entry.description,
      snippet: h.snippet,
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private buildMetadata(args: {
    name: string;
    description: string;
    body: string;
    scope: string;
    scopeKey: string | null;
    status: MemoryStatus;
    provenanceSessionId: string | null | undefined;
    provenanceAgentId: string | null | undefined;
  }): Record<string, unknown> {
    return {
      name: args.name,
      description: args.description,
      body: args.body,
      scope: args.scope,
      ...(args.scopeKey ? { scopeKey: args.scopeKey } : {}),
      status: args.status,
      ...(args.provenanceSessionId ? { provenanceSessionId: args.provenanceSessionId } : {}),
      ...(args.provenanceAgentId ? { provenanceAgentId: args.provenanceAgentId } : {}),
    };
  }

  private rowToEntry(row: Omit<MemoryRow, "containerId">): MemoryEntry {
    const meta = row.metadata ?? {};
    const type = (row.category as MemoryType | undefined) ?? "project";
    const scope = (meta.scope as MemoryEntry["scope"] | undefined) ?? defaultScopeForType(type);
    return {
      id: row.id,
      type,
      name: (meta.name as string | undefined) ?? "",
      description: (meta.description as string | undefined) ?? "",
      scope,
      scopeKey: (meta.scopeKey as string | null | undefined) ?? null,
      filePath: "",
      body: (meta.body as string | undefined) ?? row.content,
      status: row.status === "archived" ? "archived" : "active",
      confidence: Number(row.confidence ?? 0),
      provenanceSessionId: (meta.provenanceSessionId as string | null | undefined) ?? null,
      provenanceAgentId: (meta.provenanceAgentId as string | null | undefined) ?? null,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private similarHitToEntry(hit: SimilarMemoryHit): MemoryEntry {
    const meta = hit.metadata ?? {};
    const type = (hit.category as MemoryType | undefined) ?? "project";
    const scope = (meta.scope as MemoryEntry["scope"] | undefined) ?? defaultScopeForType(type);
    return {
      id: hit.id,
      type,
      name: (meta.name as string | undefined) ?? "",
      description: (meta.description as string | undefined) ?? "",
      scope,
      scopeKey: (meta.scopeKey as string | null | undefined) ?? null,
      filePath: "",
      body: (meta.body as string | undefined) ?? hit.content,
      status: hit.status === "archived" ? "archived" : "active",
      confidence: 0,
      provenanceSessionId: (meta.provenanceSessionId as string | null | undefined) ?? null,
      provenanceAgentId: (meta.provenanceAgentId as string | null | undefined) ?? null,
      useCount: 0,
      lastUsedAt: null,
      createdAt: "",
      updatedAt: "",
    };
  }
}

function renderContent(args: { name: string; description: string; body: string }): string {
  return [`# ${args.name}`, args.description, "", args.body].join("\n");
}

function snippetOf(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
}

function toPromptEntry(entry: MemoryEntry): PromptMemoryEntry {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    description: entry.description,
    body: entry.body,
  };
}

export type { FindSimilarArgs };
