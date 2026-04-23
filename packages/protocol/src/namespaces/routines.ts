import { z } from "zod";

export const routineDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("silent") }),
  z.object({ kind: z.literal("dashboard") }),
  z.object({ kind: z.literal("discord"), channelId: z.string(), guildId: z.string().optional() }),
]);
export type RoutineDelivery = z.infer<typeof routineDeliverySchema>;

export const routineRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  prompt: z.string(),
  model: z.string().nullable(),
  delivery: routineDeliverySchema,
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});
export type RoutineRecord = z.infer<typeof routineRecordSchema>;

export const routinesListParams = z.object({}).optional();
export const routinesListResult = z.object({ routines: z.array(routineRecordSchema) });

export const routinesCreateParams = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  delivery: routineDeliverySchema,
  enabled: z.boolean().default(true),
});
export const routinesCreateResult = z.object({ routine: routineRecordSchema });

export const routinesUpdateParams = z.object({
  id: z.string(),
  name: z.string().optional(),
  cron: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().nullable().optional(),
  delivery: routineDeliverySchema.optional(),
  enabled: z.boolean().optional(),
});
export const routinesUpdateResult = z.object({ routine: routineRecordSchema });

export const routinesDeleteParams = z.object({ id: z.string() });
export const routinesDeleteResult = z.object({ id: z.string() });

export const routinesRunNowParams = z.object({ id: z.string() });
export const routinesRunNowResult = z.object({ sessionId: z.string() });

export const routineMethods = {
  "routines.list": { params: routinesListParams, result: routinesListResult },
  "routines.create": { params: routinesCreateParams, result: routinesCreateResult },
  "routines.update": { params: routinesUpdateParams, result: routinesUpdateResult },
  "routines.delete": { params: routinesDeleteParams, result: routinesDeleteResult },
  "routines.run_now": { params: routinesRunNowParams, result: routinesRunNowResult },
} as const;

export const routineFiredEvent = z.object({
  routineId: z.string(),
  sessionId: z.string(),
  firedAt: z.string(),
});

export const routineEvents = {
  "routines.fired": routineFiredEvent,
} as const;
