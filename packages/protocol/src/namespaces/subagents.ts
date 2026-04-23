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
  tools: z.array(z.string()),
  systemPrompt: z.string(),
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
  subagent: z.string(),           // definition name
  input: z.unknown(),
  model: z.string().optional(),   // override
  wait: z.boolean().default(false),
});
export const subagentsSpawnResult = z.object({
  sessionId: z.string(),
  status: subagentStatusSchema,
  result: z.unknown().optional(), // populated when wait=true and the run completed
});

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
