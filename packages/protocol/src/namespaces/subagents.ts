import { z } from "zod";

export const subagentLimitsSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type SubagentLimits = z.infer<typeof subagentLimitsSchema>;

export const subagentDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  /**
   * Optional runtime identifier. When set, the subagent pool dispatches to
   * a registered `SubagentRuntime` (typically an ACP-bound external agent
   * like `acp-claude-code` or `acp-codex`) instead of running the in-process
   * Squad agent loop. Built-in runtimes are registered by plugins; an
   * unknown runtime fails the spawn loudly with a clear error.
   */
  runtime: z.string().optional(),
  tools: z.array(z.string()),
  /**
   * Toolset names this subagent inherits. Resolved by the gateway at spawn
   * time and unioned with `tools`. Refusal at spawn is loud — a missing
   * toolset short-circuits the spawn with a clear error rather than silently
   * shrinking the available toolset.
   */
  toolsets: z.array(z.string()).optional(),
  /**
   * Optional preface seeded into the named subagent's SOUL.md the first time
   * it spawns. The system prompt slot itself is always the Squad system
   * prompt — per-subagent character lives in its own SOUL.md file.
   */
  systemPrompt: z.string().optional(),
  limits: subagentLimitsSchema.optional(),
  // JSON Schema describing the `input` the subagent accepts.
  inputSchema: z.record(z.unknown()).optional(),
});
export type SubagentDefinition = z.infer<typeof subagentDefinitionSchema>;

export const subagentStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// subagents.list (registered definitions)
export const subagentsListParams = z.object({}).optional();
export const subagentsListResult = z.object({
  definitions: z.array(subagentDefinitionSchema),
});

// subagents.spawn
export const subagentsSpawnParams = z.object({
  parentSessionId: z.string(),
  /**
   * Name of a registered subagent. When omitted the spawn is ad-hoc —
   * `prompt` becomes the first user message, no per-subagent SOUL/USER/MEMORY
   * is loaded, and `tools`/`toolsets`/`model` come from the call directly.
   */
  subagent: z.string().optional(),
  /**
   * First user message handed to the subagent. Required for ad-hoc spawns.
   * For named spawns it's optional — the input/structured payload may be
   * enough — but a free-form prompt is usually clearer.
   */
  prompt: z.string().optional(),
  /**
   * Optional structured payload. Stringified and prepended to the first user
   * message when both `prompt` and `input` are set.
   */
  input: z.unknown().optional(),
  /** Optional human label for telemetry on ad-hoc spawns. */
  name: z.string().optional(),
  /** Tool ids unioned with the definition's tools (or used directly ad-hoc). */
  tools: z.array(z.string()).optional(),
  /** Toolset bundles unioned with the definition's tools. */
  toolsets: z.array(z.string()).optional(),
  model: z.string().optional(),   // override
  wait: z.boolean().default(false),
});
export const subagentsSpawnResult = z.object({
  sessionId: z.string(),
  status: subagentStatusSchema,
  result: z.unknown().optional(), // populated when wait=true and the run completed
});

// subagents.create — register or replace a definition at runtime. Persists
// to subagent_defs so the registration survives a restart, and seeds the
// subagent's per-name core directory under <workspace>/.squad/subagents/.
export const subagentsCreateParams = z.object({
  name: z.string().min(1),
  description: z.string(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  toolsets: z.array(z.string()).optional(),
  /**
   * Optional preface for the named subagent's SOUL.md. Only seeded the first
   * time the subagent is created; subsequent updates leave the file alone.
   */
  systemPrompt: z.string().optional(),
  limits: subagentLimitsSchema.optional(),
  inputSchema: z.record(z.unknown()).optional(),
  /** Replace an existing definition with the same name. Defaults to false. */
  overwrite: z.boolean().optional(),
});
export const subagentsCreateResult = z.object({
  definition: subagentDefinitionSchema,
  coreDir: z.string(),
});

// subagents.delete — remove a definition. Always in-memory; passes through
// to the persistence layer when one is wired.
export const subagentsDeleteParams = z.object({ name: z.string() });
export const subagentsDeleteResult = z.object({ name: z.string(), removed: z.boolean() });

// subagents.cancel
export const subagentsCancelParams = z.object({ sessionId: z.string() });
export const subagentsCancelResult = z.object({ sessionId: z.string(), cancelled: z.boolean() });

// subagents.tree
export const subagentsTreeNode: z.ZodType<{
  sessionId: string;
  subagent: string | null;
  status: z.infer<typeof subagentStatusSchema>;
  children: Array<{ sessionId: string; subagent: string | null; status: z.infer<typeof subagentStatusSchema>; children: unknown[] }>;
}> = z.lazy(() =>
  z.object({
    sessionId: z.string(),
    subagent: z.string().nullable(),
    status: subagentStatusSchema,
    children: z.array(subagentsTreeNode),
  }),
);
export const subagentsTreeParams = z.object({ rootSessionId: z.string() });
export const subagentsTreeResult = z.object({ root: subagentsTreeNode });

// subagents.history
export const subagentsHistoryParams = z.object({ sessionId: z.string() });
export const subagentsHistoryResult = z.object({
  sessionId: z.string(),
  subagent: z.string().nullable(),
  status: subagentStatusSchema,
  finalResult: z.unknown().optional(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});

export const subagentMethods = {
  "subagents.list": { params: subagentsListParams, result: subagentsListResult },
  "subagents.spawn": { params: subagentsSpawnParams, result: subagentsSpawnResult },
  "subagents.cancel": { params: subagentsCancelParams, result: subagentsCancelResult },
  "subagents.tree": { params: subagentsTreeParams, result: subagentsTreeResult },
  "subagents.history": { params: subagentsHistoryParams, result: subagentsHistoryResult },
  "subagents.create": { params: subagentsCreateParams, result: subagentsCreateResult },
  "subagents.delete": { params: subagentsDeleteParams, result: subagentsDeleteResult },
} as const;

// ── Events ────────────────────────────────────────────────────────────────────

export const subagentSpawnedEvent = z.object({
  parentSessionId: z.string(),
  sessionId: z.string(),
  subagent: z.string(),
  input: z.unknown(),
});
export const subagentTextDeltaEvent = z.object({
  sessionId: z.string(),
  delta: z.string(),
});
export const subagentToolCallEvent = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export const subagentToolResultEvent = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  result: z.unknown(),
  isError: z.boolean().optional(),
});
export const subagentCompletedEvent = z.object({
  sessionId: z.string(),
  result: z.unknown(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});
export const subagentFailedEvent = z.object({
  sessionId: z.string(),
  error: z.string(),
});

export const subagentEvents = {
  "subagents.spawned": subagentSpawnedEvent,
  "subagents.text_delta": subagentTextDeltaEvent,
  "subagents.tool_call": subagentToolCallEvent,
  "subagents.tool_result": subagentToolResultEvent,
  "subagents.completed": subagentCompletedEvent,
  "subagents.failed": subagentFailedEvent,
} as const;
