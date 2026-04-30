/**
 * In-memory MemCore stub for tests.
 *
 * Implements only the subset of the MemCore SDK that the gateway's
 * MemoryService actually calls. Behaviour matches the real MemCore on the
 * happy path: typed metadata round-trips, status flips on archive, search
 * returns rows that contain the query text. No vectors — text matching is
 * a simple includes() check, which is sufficient for unit-level coverage.
 */

import { randomUUID } from "node:crypto";
import type {
  AddArgs,
  FindSimilarArgs,
  IngestResult,
  ListMemoriesArgs,
  MemCore,
  MemoryRow,
  SearchArgs,
  SearchResponse,
  SimilarMemoryHit,
  UpdateMemoryArgs,
} from "memcore";

export class StubMemCore implements Partial<MemCore> {
  private readonly rows = new Map<string, MemoryRow>();
  private readonly byContainer = new Map<string, Set<string>>();

  async add(args: AddArgs): Promise<IngestResult> {
    if (args.extract === false) {
      const id = randomUUID();
      const now = new Date();
      const row: MemoryRow = {
        id,
        containerId: args.containerTag,
        content: args.content ?? "",
        category: args.category ?? "fact",
        status: "active",
        version: 1,
        confidence: args.confidence ?? 1,
        documentDate: args.documentDate ?? null,
        eventDate: null,
        eventDatePrecision: null,
        promptVersion: "manual",
        extractorModel: "manual",
        metadata: (args.metadata ?? {}) as Record<string, unknown>,
        useCount: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(id, row);
      this.scope(args.containerTag).add(id);
      return {
        conversationId: "",
        ingestionStatus: "complete",
        chunksWritten: 0,
        memoriesWritten: 1,
        edgesWritten: 0,
        memoriesSuperseded: 0,
        duplicatesSkipped: 0,
        memories: [
          {
            id,
            content: row.content,
            category: row.category,
            status: row.status,
            confidence: row.confidence,
          },
        ],
      };
    }
    return {
      conversationId: randomUUID(),
      ingestionStatus: "complete",
      chunksWritten: 0,
      memoriesWritten: 0,
      edgesWritten: 0,
      memoriesSuperseded: 0,
      duplicatesSkipped: 0,
      memories: [],
    };
  }

  async get(args: { containerTag: string; id: string }): Promise<MemoryRow | null> {
    if (!this.scope(args.containerTag).has(args.id)) return null;
    return this.rows.get(args.id) ?? null;
  }

  async list(args: ListMemoriesArgs): Promise<MemoryRow[]> {
    const ids = this.scope(args.containerTag);
    const all: MemoryRow[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row) continue;
      if (args.filters?.status) {
        const wanted = Array.isArray(args.filters.status)
          ? args.filters.status
          : [args.filters.status];
        if (!wanted.includes(row.status as never)) continue;
      } else if (row.status !== "active") {
        continue;
      }
      if (args.filters?.categories && args.filters.categories.length > 0) {
        if (!args.filters.categories.includes(row.category as never)) continue;
      }
      if (args.filters?.metadata) {
        let match = true;
        for (const [k, v] of Object.entries(args.filters.metadata)) {
          if (row.metadata[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }
      all.push(row);
    }
    if (args.sort === "recency") {
      all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    } else if (args.sort === "use_count") {
      all.sort((a, b) => b.useCount - a.useCount);
    } else if (args.sort === "created_at") {
      all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    if (args.limit !== undefined) return all.slice(0, args.limit);
    return all;
  }

  async search(args: SearchArgs): Promise<SearchResponse> {
    const ids = this.scope(args.containerTag);
    const q = args.query.toLowerCase().trim();
    const tokens = q.split(/\s+/).filter((t) => t.length > 1);
    const wantedStatuses = (() => {
      const s = args.filters?.status ?? "active";
      return new Set<string>(Array.isArray(s) ? s : [s]);
    })();
    const wantedCategories = args.filters?.categories;
    const candidates: { row: MemoryRow; score: number }[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row) continue;
      if (!wantedStatuses.has(row.status)) continue;
      if (wantedCategories && wantedCategories.length > 0 && !wantedCategories.includes(row.category as never)) continue;
      const haystack = `${row.content} ${JSON.stringify(row.metadata)}`.toLowerCase();
      const score = tokens.reduce((acc, t) => (haystack.includes(t) ? acc + 1 : acc), 0);
      if (score === 0) continue;
      candidates.push({ row, score });
    }
    candidates.sort((a, b) => b.score - a.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
    const limit = args.limit ?? 10;
    const top = candidates.slice(0, limit);
    return {
      results: top.map(({ row, score }) => ({
        memory: {
          id: row.id,
          content: row.content,
          category: row.category,
          status: row.status,
          version: row.version,
          confidence: row.confidence,
          documentDate: row.documentDate,
          eventDate: row.eventDate,
          eventDatePrecision: row.eventDatePrecision,
          promptVersion: row.promptVersion,
          extractorModel: row.extractorModel,
          metadata: row.metadata,
          useCount: row.useCount,
          lastUsedAt: row.lastUsedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          score,
          chunks: [],
        },
        score,
        relatedMemories: [],
      })),
      profile: null,
      queryMetadata: {
        totalCandidates: candidates.length,
        latencyMs: 0,
        shouldAbstain: false,
        abstainReason: null,
        profileRelevant: false,
      },
    };
  }

  async findSimilar(args: FindSimilarArgs): Promise<SimilarMemoryHit[]> {
    const ids = this.scope(args.containerTag);
    const needle = args.content.toLowerCase();
    const wantedStatuses = new Set(args.statuses ?? ["active"]);
    const out: SimilarMemoryHit[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row) continue;
      if (!wantedStatuses.has(row.status as never)) continue;
      if (row.content.toLowerCase().includes(needle) || needle.includes(row.content.toLowerCase())) {
        out.push({
          id: row.id,
          content: row.content,
          category: row.category,
          status: row.status,
          similarity: 1,
          metadata: row.metadata,
          documentDate: row.documentDate,
        });
      }
    }
    return out.slice(0, args.limit ?? 5);
  }

  async update(args: UpdateMemoryArgs): Promise<MemoryRow> {
    const row = this.rows.get(args.id);
    if (!row) throw new Error(`memory ${args.id} not found`);
    const next: MemoryRow = {
      ...row,
      content: args.content ?? row.content,
      metadata: args.metadata !== undefined ? (args.metadata as Record<string, unknown>) : row.metadata,
      category: args.category ?? row.category,
      eventDate: args.eventDate !== undefined ? args.eventDate : row.eventDate,
      eventDatePrecision: args.eventDatePrecision ?? row.eventDatePrecision,
      confidence: args.confidence ?? row.confidence,
      version: args.content !== undefined ? row.version + 1 : row.version,
      updatedAt: new Date(),
    };
    this.rows.set(args.id, next);
    return next;
  }

  async archive(args: { containerTag: string; id: string }): Promise<MemoryRow> {
    const row = this.rows.get(args.id);
    if (!row) throw new Error(`memory ${args.id} not found`);
    const next: MemoryRow = { ...row, status: "archived", updatedAt: new Date() };
    this.rows.set(args.id, next);
    return next;
  }

  async recordUse(_args: { containerTag: string; ids: string | string[] }): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  private scope(tag: string): Set<string> {
    let s = this.byContainer.get(tag);
    if (!s) {
      s = new Set();
      this.byContainer.set(tag, s);
    }
    return s;
  }
}
