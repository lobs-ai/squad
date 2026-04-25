/**
 * MemoryBackend — minimal interface the memory tools talk to.
 *
 * The gateway implements this against its MemoryStore; tests stub it.
 * Tools never import from the gateway directly.
 */

export type MemoryType = "user" | "feedback" | "project" | "reference" | "working";
export type MemoryScope = "global" | "project" | "tree";
export type MemoryStatus = "active" | "archived";

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

export interface MemoryArchiveInput {
  id: string;
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

export interface MemoryListInput {
  type?: MemoryType;
  scope?: MemoryScope;
  scopeKey?: string | null;
  status?: MemoryStatus;
}

export interface MemoryBackend {
  propose(input: MemoryProposeInput): Promise<MemoryEntry>;
  update(input: MemoryUpdateInput): Promise<MemoryEntry>;
  archive(input: MemoryArchiveInput): Promise<MemoryEntry>;
  search(input: MemorySearchInput): Promise<MemorySearchHit[]>;
  list(input: MemoryListInput): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | null>;
}
