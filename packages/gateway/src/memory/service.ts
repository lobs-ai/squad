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
  Embedder,
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

/**
 * Embedder plus an optional self-reported input limit. Memcore's `Embedder`
 * contract no longer carries `maxInputChars`, but gateway-side chunked
 * retrieval still honors it when a concrete implementation chooses to
 * expose one — purely as a hint, never required.
 */
export type EmbedderWithLimit = Embedder & { readonly maxInputChars?: number };

export interface MemoryServiceOptions {
  containerTag?: string;
  /** Eager-block char budget. Defaults to EAGER_BLOCK_BUDGET. */
  eagerBudget?: number;
  /**
   * Optional reference to the embedder MemCore was constructed with. When
   * present and it reports a `maxInputChars`, `retrievalForTurn` uses that
   * to size chunks for long queries. Otherwise the service falls back to a
   * conservative 2000-char cap that fits every mainstream embedder's
   * context window.
   */
  embedder?: EmbedderWithLimit;
}

/**
 * Floor used when the embedder doesn't report a limit. Picked to fit the
 * smallest context window we expect to see in the wild (mxbai-embed-large,
 * bge-large-en — both 512 tokens ≈ 2000 chars with margin).
 */
const FALLBACK_EMBEDDER_LIMIT_CHARS = 2000;

/**
 * Soft floor on chunk size. Below this the marginal benefit of an extra
 * chunk gets eaten by overlap. If a model's reported limit is smaller than
 * this we just use the model's number — it's a hint, not a guarantee.
 */
const MIN_CHUNK_CHARS = 400;

/**
 * Overlap between adjacent chunks, expressed as a fraction of chunk size.
 * 20% is the standard RAG starting point — keeps phrases that straddle
 * boundaries from being lost.
 */
const CHUNK_OVERLAP_RATIO = 0.2;

export class MemoryService {
  private readonly containerTag: string;
  private readonly eagerBudget: number;
  private readonly embedder?: EmbedderWithLimit;
  private readonly eagerCache = new Map<string, PromptMemoryEntry[]>();

  constructor(
    private readonly memcore: MemCore,
    private readonly logger: Logger,
    opts: MemoryServiceOptions = {},
  ) {
    this.containerTag = opts.containerTag ?? "squad";
    this.eagerBudget = opts.eagerBudget ?? EAGER_BLOCK_BUDGET;
    if (opts.embedder !== undefined) this.embedder = opts.embedder;
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
    return this.rowToEntry(row);
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
    return this.rowToEntry(updated);
  }

  async archive(
    id: string,
    _opts: { reason?: string; agentId?: string | null } = {},
  ): Promise<MemoryEntry> {
    const row = await this.memcore.archive({ containerTag: this.containerTag, id });
    return this.rowToEntry(row);
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
   *
   * For queries that fit the embedder's max input length, this is one
   * `embed` + one search — same cost as before. For queries that exceed
   * the limit (long pasted contexts, multi-message windows, the
   * setup-with-agent briefing), the query is split into overlapping
   * windows; each window runs its own search; results merge by id with
   * max-score wins. That keeps signal from the *whole* query alive
   * instead of throwing away everything past the embedder's window.
   */
  async retrievalForTurn(
    query: string,
    opts: { scopeKey?: string | null; limit?: number } = {},
  ): Promise<PromptMemoryHit[]> {
    if (!query || query.trim().length < 4) return [];
    const limit = opts.limit ?? 4;
    const maxChars = this.embedder?.maxInputChars ?? FALLBACK_EMBEDDER_LIMIT_CHARS;
    const chunks = chunkQuery(query, maxChars);

    // Single-chunk fast path — same shape as the old code, no extra work.
    if (chunks.length === 1) {
      const hits = await this.search({
        query: chunks[0]!,
        types: ["project", "reference"],
        ...(opts.scopeKey !== undefined ? { scopeKey: opts.scopeKey } : {}),
        limit,
      });
      return hits.map(toPromptHit);
    }

    // Multi-chunk: each chunk asks for `limit` hits so we have headroom
    // for de-duplication. Run in parallel — embedders handle concurrent
    // requests fine and serial would multiply latency by chunk count.
    const perChunk = await Promise.all(
      chunks.map((chunk) =>
        this.search({
          query: chunk,
          types: ["project", "reference"],
          ...(opts.scopeKey !== undefined ? { scopeKey: opts.scopeKey } : {}),
          limit,
        }).catch((err) => {
          // One chunk's failure doesn't kill the whole retrieval — log
          // and treat that chunk as empty. Keeps a flaky embedder from
          // ruining a turn that other chunks could have salvaged.
          this.logger.warn(
            { err, chunkLen: chunk.length },
            "memory chunked retrieval: one chunk failed — continuing",
          );
          return [] as MemorySearchHit[];
        }),
      ),
    );

    // Merge: for each memory id seen in any chunk's results, keep the
    // highest score. Ranking by max is conservative — an entry that
    // strongly matched one part of the query beats an entry that weakly
    // matched several. This is the right call for retrieval where
    // precision matters more than thematic coverage.
    const bestById = new Map<string, MemorySearchHit>();
    for (const chunkHits of perChunk) {
      for (const hit of chunkHits) {
        const prior = bestById.get(hit.entry.id);
        if (!prior || hit.score > prior.score) bestById.set(hit.entry.id, hit);
      }
    }
    const merged = [...bestById.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return merged.map(toPromptHit);
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

function toPromptHit(h: MemorySearchHit): PromptMemoryHit {
  return {
    id: h.entry.id,
    type: h.entry.type,
    name: h.entry.name,
    description: h.entry.description,
    snippet: h.snippet,
  };
}

/**
 * Split `query` into overlapping windows that each fit within `maxChars`.
 *
 * Tries to split at paragraph / sentence / word boundaries so phrases
 * aren't sliced mid-word — embedders are sensitive to broken tokens at
 * the edge of an input. Falls through to character cuts only when there
 * are no boundaries inside the window.
 *
 * Returns a single-element array when the query already fits, so callers
 * can use `chunks.length === 1` as the fast-path check.
 */
export function chunkQuery(query: string, maxChars: number): string[] {
  if (query.length <= maxChars) return [query];
  const chunkSize = Math.max(MIN_CHUNK_CHARS, Math.floor(maxChars));
  const overlap = Math.floor(chunkSize * CHUNK_OVERLAP_RATIO);
  const stride = Math.max(1, chunkSize - overlap);

  const chunks: string[] = [];
  let start = 0;
  while (start < query.length) {
    const idealEnd = Math.min(start + chunkSize, query.length);
    let end = idealEnd;
    if (end < query.length) {
      // Search backwards from `end` for the best break point. Preferences:
      // double-newline → newline → sentence punct → space. Cap the search
      // window so we don't degrade to O(N^2) on adversarial inputs.
      const searchFloor = Math.max(start + Math.floor(chunkSize / 2), end - 200);
      const slice = query.slice(searchFloor, end);
      const candidates = [
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! "),
        slice.lastIndexOf(" "),
      ].filter((i) => i >= 0);
      if (candidates.length > 0) {
        end = searchFloor + Math.max(...candidates) + 1;
      }
    }
    chunks.push(query.slice(start, end));
    if (end >= query.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export type { FindSimilarArgs };
