/**
 * Public types for the memory subsystem. Kept in their own file so the
 * `@squad/tools` package can import the shape without pulling in the gateway.
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference", "working"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ["global", "project", "tree"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUSES = ["active", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  name: string;
  description: string;
  scope: MemoryScope;
  scopeKey: string | null;
  filePath: string;
  body: string;
  status: MemoryStatus;
  confidence: number;
  provenanceSessionId: string | null;
  provenanceAgentId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryProposeInput {
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  scope?: MemoryScope;
  scopeKey?: string | null;
  confidence?: number;
  sessionId?: string | null;
  agentId?: string | null;
}

export interface MemoryUpdateInput {
  id: string;
  description?: string;
  body?: string;
  confidence?: number;
  reason?: string;
  agentId?: string | null;
}

export interface MemorySearchInput {
  query: string;
  types?: MemoryType[];
  scopes?: MemoryScope[];
  scopeKey?: string | null;
  limit?: number;
  includeArchived?: boolean;
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

/** Per-type budget for the body, in characters. Hard cap at write-time. */
export const MEMORY_BODY_BUDGET: Record<MemoryType, number> = {
  user: 800,
  feedback: 600,
  project: 1200,
  reference: 600,
  working: 1500,
};

/** Eager block target — total chars of `user` + `feedback` injected each turn. */
export const EAGER_BLOCK_BUDGET = 3000;
