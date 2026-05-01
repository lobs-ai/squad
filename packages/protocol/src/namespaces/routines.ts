import { z } from "zod";

// -- Delivery --------------------------------------------------------------

export const routineDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("silent") }),
  z.object({ kind: z.literal("dashboard") }),
  z.object({ kind: z.literal("discord"), channelId: z.string(), guildId: z.string().optional() }),
]);
export type RoutineDelivery = z.infer<typeof routineDeliverySchema>;

// -- Schedule --------------------------------------------------------------

export const cronScheduleSchema = z.object({
  kind: z.literal("cron"),
  expr: z.string().min(1),
  tz: z.string().optional(),
  staggerMs: z.number().int().nonnegative().optional(),
});
export const intervalScheduleSchema = z.object({
  kind: z.literal("interval"),
  everyMs: z.number().int().positive(),
  anchor: z.string().optional(), // ISO timestamp; defaults to creation time
});
export const onceScheduleSchema = z.object({
  kind: z.literal("once"),
  at: z.string(), // ISO timestamp
});

/**
 * Webhook-driven routine: fires when an HTTP POST lands at
 * `/webhook/<routine-id>`. The request body is forwarded into the routine
 * payload (substituted into `{{body}}` / `{{header.X}}` / `{{query.X}}`
 * placeholders for prompt-style payloads, or attached as the first
 * `agentTurn` message for agentTurn payloads). `auth` controls how
 * the gateway verifies the caller; `none` is allowed but heavily
 * discouraged outside of dev.
 */
export const webhookScheduleSchema = z.object({
  kind: z.literal("webhook"),
  /**
   * Authorization mode for incoming requests.
   *  - `secret`: caller passes `?token=<secret>` or `Authorization: Bearer <secret>`
   *  - `hmac`:   caller signs the body; gateway recomputes HMAC-SHA256 with `secret`
   *               and compares against `X-Squad-Signature` (hex)
   *  - `none`:   no auth (only for trusted networks).
   */
  auth: z.enum(["secret", "hmac", "none"]).default("secret"),
  /**
   * Shared secret. Required for `secret` and `hmac`; ignored when `none`.
   * Stored in plaintext in the routine record — keep separate from regular
   * config and rotate via `routines.update`.
   */
  secret: z.string().optional(),
});
export const scheduleSchema = z.discriminatedUnion("kind", [
  cronScheduleSchema,
  intervalScheduleSchema,
  onceScheduleSchema,
  webhookScheduleSchema,
]);
export type CronSchedule = z.infer<typeof cronScheduleSchema>;
export type IntervalSchedule = z.infer<typeof intervalScheduleSchema>;
export type OnceSchedule = z.infer<typeof onceScheduleSchema>;
export type WebhookSchedule = z.infer<typeof webhookScheduleSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;

// -- Payload ---------------------------------------------------------------

export const promptPayloadSchema = z.object({
  kind: z.literal("prompt"),
  text: z.string().min(1),
  skills: z.array(z.string()).optional(),
});
export const agentTurnPayloadSchema = z.object({
  kind: z.literal("agentTurn"),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "system"]),
        text: z.string(),
      }),
    )
    .min(1),
});
export const scriptPayloadSchema = z.object({
  kind: z.literal("script"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});
export const payloadSchema = z.discriminatedUnion("kind", [
  promptPayloadSchema,
  agentTurnPayloadSchema,
  scriptPayloadSchema,
]);
export type PromptPayload = z.infer<typeof promptPayloadSchema>;
export type AgentTurnPayload = z.infer<typeof agentTurnPayloadSchema>;
export type ScriptPayload = z.infer<typeof scriptPayloadSchema>;
export type Payload = z.infer<typeof payloadSchema>;

// -- Session targeting -----------------------------------------------------

export const sessionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }),
  z.object({ kind: z.literal("isolated") }),
  z.object({ kind: z.literal("session"), sessionId: z.string() }),
]);
export type SessionTarget = z.infer<typeof sessionTargetSchema>;

// -- Per-job execution overrides ------------------------------------------

export const executionSchema = z.object({
  model: z.string().nullable().optional(),
  fallbacks: z.array(z.string()).optional(),
  toolsAllow: z.array(z.string()).optional(),
  timeoutSec: z.number().int().positive().optional(),
});
export type Execution = z.infer<typeof executionSchema>;

// -- Failure alerting ------------------------------------------------------

export const failureSchema = z.object({
  alertChannel: z.string().optional(),
  cooldownSec: z.number().int().nonnegative().default(3600),
});
export type FailureConfig = z.infer<typeof failureSchema>;

// -- Job record ------------------------------------------------------------
//
// Keeps the legacy fields (cron, prompt, model, lastRunAt, nextRunAt) so
// existing dashboards/clients keep working. New clients should consume the
// structured `schedule`, `payload`, `session`, `execution`, `failure` fields.

export const routineRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),

  // Structured fields (new):
  schedule: scheduleSchema,
  payload: payloadSchema,
  session: sessionTargetSchema,
  execution: executionSchema.default({}),
  failure: failureSchema.optional(),
  delivery: routineDeliverySchema,

  // Runtime state (mirrored from state.json into the record on read):
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastStatus: z.enum(["ok", "error", "skipped"]).nullable().default(null),
  lastError: z.string().nullable().default(null),
  consecutiveErrors: z.number().int().nonnegative().default(0),

  // Legacy mirrors — populated for back-compat:
  cron: z.string(),                     // mirrors schedule when kind === "cron", "" otherwise
  prompt: z.string(),                   // mirrors payload when kind === "prompt", "" otherwise
  model: z.string().nullable(),         // mirrors execution.model
});
export type RoutineRecord = z.infer<typeof routineRecordSchema>;

// -- Method params/results -------------------------------------------------

export const routinesListParams = z.object({}).optional();
export const routinesListResult = z.object({ routines: z.array(routineRecordSchema) });

/**
 * Create accepts either the new structured shape or the legacy flat shape
 * (cron + prompt + optional model). Both round-trip to the same record.
 */
const createInputSchema = z.union([
  // Structured form (preferred):
  z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    schedule: scheduleSchema,
    payload: payloadSchema,
    session: sessionTargetSchema.default({ kind: "new" }),
    execution: executionSchema.default({}),
    failure: failureSchema.optional(),
    delivery: routineDeliverySchema,
  }),
  // Legacy form (kept working):
  z.object({
    name: z.string().min(1),
    cron: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().optional(),
    delivery: routineDeliverySchema,
    enabled: z.boolean().default(true),
  }),
]);

export const routinesCreateParams = createInputSchema;
export const routinesCreateResult = z.object({ routine: routineRecordSchema });

export const routinesUpdateParams = z.object({
  id: z.string(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: scheduleSchema.optional(),
  payload: payloadSchema.optional(),
  session: sessionTargetSchema.optional(),
  execution: executionSchema.optional(),
  failure: failureSchema.optional(),
  delivery: routineDeliverySchema.optional(),
  // Legacy passthroughs:
  cron: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().nullable().optional(),
});
export const routinesUpdateResult = z.object({ routine: routineRecordSchema });

export const routinesDeleteParams = z.object({ id: z.string() });
export const routinesDeleteResult = z.object({ id: z.string() });

export const routinesRunNowParams = z.object({ id: z.string() });
export const routinesRunNowResult = z.object({ sessionId: z.string().nullable() });

// Run history — query and tail.

export const routineRunLogSchema = z.object({
  ts: z.string(),
  status: z.enum(["ok", "error", "skipped"]),
  durationMs: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  payloadKind: z.enum(["prompt", "agentTurn", "script"]),
  output: z.string().optional(),
  error: z.string().optional(),
  delivery: z
    .object({ kind: z.string(), ok: z.boolean(), error: z.string().optional() })
    .optional(),
  tokens: z.object({ in: z.number(), out: z.number() }).optional(),
});
export type RoutineRunLog = z.infer<typeof routineRunLogSchema>;

export const routinesRunsParams = z.object({
  jobId: z.string(),
  limit: z.number().int().positive().max(500).default(50),
  status: z.enum(["ok", "error", "skipped"]).optional(),
});
export const routinesRunsResult = z.object({ runs: z.array(routineRunLogSchema) });

export const routinesTailParams = z.object({
  jobId: z.string(),
  limit: z.number().int().positive().max(50).default(10),
});
export const routinesTailResult = z.object({ runs: z.array(routineRunLogSchema) });

export const routineMethods = {
  "routines.list": { params: routinesListParams, result: routinesListResult },
  "routines.create": { params: routinesCreateParams, result: routinesCreateResult },
  "routines.update": { params: routinesUpdateParams, result: routinesUpdateResult },
  "routines.delete": { params: routinesDeleteParams, result: routinesDeleteResult },
  "routines.run_now": { params: routinesRunNowParams, result: routinesRunNowResult },
  "routines.runs": { params: routinesRunsParams, result: routinesRunsResult },
  "routines.tail": { params: routinesTailParams, result: routinesTailResult },
} as const;

export const routineFiredEvent = z.object({
  routineId: z.string(),
  sessionId: z.string().nullable(),
  firedAt: z.string(),
  status: z.enum(["ok", "error", "skipped"]).optional(),
});

export const routineEvents = {
  "routines.fired": routineFiredEvent,
} as const;
