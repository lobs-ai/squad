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
});
export const sessionSearchHit = z.object({
  session: sessionRecordSchema,
  snippet: z.string(),
});
export const sessionSearchResult = z.object({ hits: z.array(sessionSearchHit) });

export const sessionMethods = {
  "session.start": { params: sessionStartParams, result: sessionStartResult },
  "session.resume": { params: sessionResumeParams, result: sessionResumeResult },
  "session.end": { params: sessionEndParams, result: sessionEndResult },
  "session.list": { params: sessionListParams, result: sessionListResult },
  "session.search": { params: sessionSearchParams, result: sessionSearchResult },
} as const;
