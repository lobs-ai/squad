import { z } from "zod";

export const sessionStatus = z.enum(["idle", "running", "ended"]);
export type SessionStatus = z.infer<typeof sessionStatus>;

export const deliveryMode = z.enum(["interrupt", "queue"]);
export type DeliveryMode = z.infer<typeof deliveryMode>;

export const sessionRecordSchema = z.object({
  id: z.string(),
  parentSessionId: z.string().nullable(),
  subagentDefId: z.string().nullable(),
  title: z.string().nullable(),
  platform: z.string().nullable(),
  remoteId: z.string().nullable(),
  model: z.string(),
  /**
   * Ordered list of fallback models. Empty when the session has no fallback
   * chain beyond the primary. Fallbacks are sticky for the life of the
   * session — once one takes over, the runner stays on it.
   */
  fallbacks: z.array(z.string()).default([]),
  /**
   * Per-session override for the model used to auto-generate a title from
   * the first user message. `null` means "use the gateway default" — which
   * itself falls back to the session's primary model.
   */
  titleModel: z.string().nullable().default(null),
  status: sessionStatus,
  deliveryMode: deliveryMode,
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

// session.start
export const sessionStartParams = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
  platform: z.string().optional(),
  remoteId: z.string().optional(),
  systemPrompt: z.string().optional(),
  deliveryMode: deliveryMode.optional(),
});
export const sessionStartResult = z.object({ session: sessionRecordSchema });

// session.resume
export const sessionResumeParams = z.object({ sessionId: z.string() });
export const sessionResumeResult = z.object({ session: sessionRecordSchema });

// session.end
export const sessionEndParams = z.object({ sessionId: z.string() });
export const sessionEndResult = z.object({ session: sessionRecordSchema });

// session.list
export const sessionListParams = z.object({
  parentSessionId: z.string().nullable().optional(),
  limit: z.number().int().positive().max(500).default(50),
  cursor: z.string().optional(),
});
export const sessionListResult = z.object({
  sessions: z.array(sessionRecordSchema),
  nextCursor: z.string().optional(),
});

// session.search (FTS5)
export const sessionSearchParams = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(200).default(20),
  /** Optional — restrict the search to messages within a single session. */
  sessionId: z.string().optional(),
});
export const sessionSearchHit = z.object({
  /**
   * Full session record. Preserved for back-compat with the v0 stub. New
   * clients should prefer `sessionId` + `messageId` for jumping straight
   * to the matched message.
   */
  session: sessionRecordSchema,
  sessionId: z.string(),
  messageId: z.string(),
  snippet: z.string(),
  ts: z.string(),
  /** FTS5 relevance score — lower is better (BM25 default). */
  score: z.number(),
});
export const sessionSearchResult = z.object({ hits: z.array(sessionSearchHit) });

// session.rename — change a session's title
export const sessionRenameParams = z.object({
  sessionId: z.string(),
  title: z.string().min(1).max(200),
});
export const sessionRenameResult = z.object({ session: sessionRecordSchema });

// session.setModel — swap the primary model (and optionally fallbacks) on an
// existing session. Sticky for subsequent runs; does not retroactively rewrite
// history. Fallbacks is optional; omitting leaves the chain untouched.
export const sessionSetModelParams = z.object({
  sessionId: z.string(),
  model: z.string().min(1),
  fallbacks: z.array(z.string()).optional(),
});
export const sessionSetModelResult = z.object({ session: sessionRecordSchema });

// session.setTitleModel — override the model used for this session's
// auto-generated title. `null` clears the override and falls back to the
// gateway-wide setting.
export const sessionSetTitleModelParams = z.object({
  sessionId: z.string(),
  titleModel: z.string().nullable(),
});
export const sessionSetTitleModelResult = z.object({ session: sessionRecordSchema });

// session.stats — detailed breakdown: turn count, token totals, estimated
// context fill, message counts. Used by /usage and /compress.
export const sessionStatsParams = z.object({ sessionId: z.string() });
export const sessionStatsResult = z.object({
  session: sessionRecordSchema,
  messageCount: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().nonnegative().nullable(),
  contextFillPct: z.number().nullable(),
});

// session.compact — request the next run to compress history. Returns stats
// reflecting the current state; the runner observes a `compactAtStart` flag
// and drops older turns on the subsequent chat.send.
export const sessionCompactParams = z.object({ sessionId: z.string() });
export const sessionCompactResult = z.object({
  session: sessionRecordSchema,
  queued: z.boolean(),
  beforeMessageCount: z.number().int().nonnegative(),
  beforeEstimatedTokens: z.number().int().nonnegative(),
});

export const sessionMethods = {
  "session.start": { params: sessionStartParams, result: sessionStartResult },
  "session.resume": { params: sessionResumeParams, result: sessionResumeResult },
  "session.end": { params: sessionEndParams, result: sessionEndResult },
  "session.list": { params: sessionListParams, result: sessionListResult },
  "session.search": { params: sessionSearchParams, result: sessionSearchResult },
  "session.rename": { params: sessionRenameParams, result: sessionRenameResult },
  "session.setModel": { params: sessionSetModelParams, result: sessionSetModelResult },
  "session.setTitleModel": {
    params: sessionSetTitleModelParams,
    result: sessionSetTitleModelResult,
  },
  "session.stats": { params: sessionStatsParams, result: sessionStatsResult },
  "session.compact": { params: sessionCompactParams, result: sessionCompactResult },
} as const;

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * Fired when a session is created or its persisted record changes
 * (rename, model swap, title-model override, status flip, token counters).
 * Subscribers use this to keep their local session list live without
 * having to poll `session.list`.
 *
 * The event is flat (no `/sessionId` suffix) so a single subscription
 * covers every session in the squad.
 */
export const sessionCreatedEvent = z.object({ session: sessionRecordSchema });
export const sessionUpdatedEvent = z.object({ session: sessionRecordSchema });

/**
 * Fires when an external signal asks a session to resume — typically a
 * background subagent finishing, a webhook landing, or any other "the world
 * changed, give the agent another turn" trigger. Channels and clients can
 * surface this as a notification; the gateway's coordinator also uses it to
 * decide whether to start a fresh turn.
 *
 * Suffixed with `/<sessionId>` so subscribers can scope per-session. Reasons
 * are deliberately freeform — common values include `subagent_completed`,
 * `subagent_failed`, `webhook`, `routine_fired`.
 */
export const sessionWakeEvent = z.object({
  sessionId: z.string(),
  reason: z.string(),
  /** Optional structured detail — varies per `reason`. */
  detail: z.record(z.unknown()).optional(),
  occurredAt: z.string(),
});

export const sessionEvents = {
  "session.created": sessionCreatedEvent,
  "session.updated": sessionUpdatedEvent,
  "session.wake": sessionWakeEvent,
} as const;
