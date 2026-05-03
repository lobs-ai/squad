import { z } from "zod";

export const logLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const logEntrySchema = z.object({
  id: z.number().int().nonnegative(),
  time: z.string(),
  level: logLevelSchema,
  source: z.string().nullable(),
  msg: z.string(),
  bindings: z.record(z.unknown()),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const logsTailParams = z.object({
  /** Drop entries whose level rank is below this. */
  level: logLevelSchema.optional(),
  /** Filter to a single source (component/service label). */
  source: z.string().optional(),
  /** Only return entries newer than this id (live polling). */
  sinceId: z.number().int().nonnegative().optional(),
  /** Substring match across msg / source / string-valued bindings. */
  q: z.string().optional(),
  /** Hard cap; defaults applied server-side. */
  limit: z.number().int().positive().max(2000).optional(),
});
export const logsTailResult = z.object({
  entries: z.array(logEntrySchema),
  /** Distinct source labels currently in the buffer (for filter UIs). */
  sources: z.array(z.string()),
});

export const logMethods = {
  "logs.tail": { params: logsTailParams, result: logsTailResult },
} as const;

export const logsEntryEvent = z.object({ entry: logEntrySchema });

export const logEvents = {
  "logs.entry": logsEntryEvent,
} as const;
