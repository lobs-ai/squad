import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type {
  MemoryBackend,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "./backend.js";
import { MEMORY_GUIDANCE } from "./prompt.js";

const TYPE_ENUM = ["user", "feedback", "project", "reference", "working"] as const;
const SCOPE_ENUM = ["global", "project", "tree"] as const;

function sessionIdFrom(ctx: ToolContext): string | null {
  return (ctx.meta?.sessionId as string | undefined) ?? null;
}

function agentIdFrom(ctx: ToolContext): string | null {
  return (ctx.meta?.agentId as string | undefined) ?? null;
}

function format(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload, null, 2) };
}

// ── memory_propose ───────────────────────────────────────────────────────────

interface ProposeInput extends Record<string, unknown> {
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  scope?: MemoryScope;
  scopeKey?: string | null;
  confidence?: number;
}

export class MemoryProposeTool extends BaseTool<ProposeInput> {
  readonly name = "memory_propose";
  readonly description = [
    "Save a new typed memory entry that will persist across sessions.",
    "Returns the created entry. Rejects exact name collisions; surfaces near-duplicates so you can memory_update instead.",
    "",
    MEMORY_GUIDANCE,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      type: { type: "string", enum: [...TYPE_ENUM] },
      name: { type: "string", description: "Short stable identifier; e.g. 'user_role', 'feedback_no_mocks'" },
      description: { type: "string", description: "One-line hook (≤200 chars) used in the index" },
      body: { type: "string", description: "Full content. Include WHY for feedback/project entries." },
      scope: { type: "string", enum: [...SCOPE_ENUM], description: "Defaults: user/feedback=global, project/reference=project, working=tree" },
      scopeKey: { type: ["string", "null"], description: "Required when scope=tree (root session id)" },
      confidence: { type: "number", description: "0-100; high when user explicitly said 'remember', lower when inferred" },
    },
    required: ["type", "name", "description", "body"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: MemoryBackend) {
    super();
  }

  async run(input: ProposeInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const entry = await this.backend.propose({
      type: input.type,
      name: input.name,
      description: input.description,
      body: input.body,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.scopeKey !== undefined ? { scopeKey: input.scopeKey } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      sessionId: sessionIdFrom(ctx),
      agentId: agentIdFrom(ctx),
    });
    return format({ entry });
  }
}

// ── memory_update ────────────────────────────────────────────────────────────

interface UpdateInput extends Record<string, unknown> {
  id: string;
  description?: string;
  body?: string;
  confidence?: number;
  reason?: string;
}

export class MemoryUpdateTool extends BaseTool<UpdateInput> {
  readonly name = "memory_update";
  readonly description =
    "Edit an existing memory entry by id. Old version goes to history; never destructive.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      description: { type: "string" },
      body: { type: "string" },
      confidence: { type: "number" },
      reason: { type: "string", description: "Short explanation of what changed and why" },
    },
    required: ["id"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: MemoryBackend) {
    super();
  }

  async run(input: UpdateInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const entry = await this.backend.update({
      id: input.id,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      agentId: agentIdFrom(ctx),
    });
    return format({ entry });
  }
}

// ── memory_archive ───────────────────────────────────────────────────────────

interface ArchiveInput extends Record<string, unknown> {
  id: string;
  reason?: string;
}

export class MemoryArchiveTool extends BaseTool<ArchiveInput> {
  readonly name = "memory_archive";
  readonly description =
    "Soft-delete a memory entry: drops it from the eager block but keeps it FTS-searchable. Use when an entry is stale or wrong.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      reason: { type: "string" },
    },
    required: ["id"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: MemoryBackend) {
    super();
  }

  async run(input: ArchiveInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const entry = await this.backend.archive({
      id: input.id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      agentId: agentIdFrom(ctx),
    });
    return format({ entry });
  }
}

// ── memory_search ────────────────────────────────────────────────────────────

interface SearchInput extends Record<string, unknown> {
  query: string;
  types?: MemoryType[];
  scopes?: MemoryScope[];
  limit?: number;
  includeArchived?: boolean;
}

export class MemorySearchTool extends BaseTool<SearchInput> {
  readonly name = "memory_search";
  readonly description =
    "FTS5 search over your memory store. Returns top-k hits with snippets. Use this BEFORE memory_propose to avoid creating duplicates.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      types: { type: "array", items: { type: "string", enum: [...TYPE_ENUM] } },
      scopes: { type: "array", items: { type: "string", enum: [...SCOPE_ENUM] } },
      limit: { type: "number" },
      includeArchived: { type: "boolean" },
    },
    required: ["query"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: MemoryBackend) {
    super();
  }

  async run(input: SearchInput): Promise<ToolExecutorResult> {
    const hits = await this.backend.search({
      query: input.query,
      ...(input.types !== undefined ? { types: input.types } : {}),
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
    });
    return format({ hits });
  }
}

// ── memory_list ──────────────────────────────────────────────────────────────

interface ListInput extends Record<string, unknown> {
  type?: MemoryType;
  scope?: MemoryScope;
  status?: MemoryStatus;
}

export class MemoryListTool extends BaseTool<ListInput> {
  readonly name = "memory_list";
  readonly description = "List memory entries — optionally filtered by type/scope/status.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      type: { type: "string", enum: [...TYPE_ENUM] },
      scope: { type: "string", enum: [...SCOPE_ENUM] },
      status: { type: "string", enum: ["active", "archived"] },
    },
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: MemoryBackend) {
    super();
  }

  async run(input: ListInput): Promise<ToolExecutorResult> {
    const entries = await this.backend.list({
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    });
    return format({ entries });
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerMemoryTools(
  registry: { register(tool: AnyTool): unknown },
  backend: MemoryBackend,
): void {
  registry.register(new MemoryProposeTool(backend) as unknown as AnyTool);
  registry.register(new MemoryUpdateTool(backend) as unknown as AnyTool);
  registry.register(new MemoryArchiveTool(backend) as unknown as AnyTool);
  registry.register(new MemorySearchTool(backend) as unknown as AnyTool);
  registry.register(new MemoryListTool(backend) as unknown as AnyTool);
}
