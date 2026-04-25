import type { PromptMemoryEntry, PromptMemoryHit } from "../agent-prompt.js";
import type { MemoryStore } from "./store.js";

/**
 * MemoryService — read-side helper that turns the MemoryStore into the
 * eager + retrieval blocks the prompt builder consumes.
 *
 * The eager block is computed once per session and cached, so subsequent
 * turns in the same session see the same frozen prefix. Cache eviction
 * happens on process restart (which already busts the prompt cache anyway).
 */
export class MemoryService {
  private readonly eagerCache = new Map<string, PromptMemoryEntry[]>();

  constructor(private readonly store: MemoryStore) {}

  /**
   * Eager block: user + feedback entries, frozen for the lifetime of this
   * session. First call snapshots; subsequent calls return the snapshot.
   */
  eagerForSession(sessionId: string): PromptMemoryEntry[] {
    const cached = this.eagerCache.get(sessionId);
    if (cached) return cached;
    const snapshot = this.store.pickEagerBlock().map(toPromptEntry);
    this.eagerCache.set(sessionId, snapshot);
    return snapshot;
  }

  /** Drop the cached snapshot — useful after a memory edit if you want it visible mid-session. */
  invalidateSession(sessionId: string): void {
    this.eagerCache.delete(sessionId);
  }

  /**
   * Retrieval block: per-turn FTS over project + reference entries, scored
   * against the latest user input. Empty if the query is too short.
   */
  retrievalForTurn(query: string, opts: { scopeKey?: string | null; limit?: number } = {}): PromptMemoryHit[] {
    if (!query || query.trim().length < 4) return [];
    const hits = this.store.search({
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
}

function toPromptEntry(entry: { id: string; type: string; name: string; description: string; body: string }): PromptMemoryEntry {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    description: entry.description,
    body: entry.body,
  };
}
