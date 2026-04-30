import { z } from "zod";
import { sessionMethods, sessionEvents } from "./session.js";
import { chatMethods, chatEvents } from "./chat.js";
import { subagentMethods, subagentEvents } from "./subagents.js";
import { taskMethods, taskEvents } from "./tasks.js";
import { questionMethods, questionEvents } from "./questions.js";
import { approvalMethods, approvalEvents } from "./approvals.js";
import { pluginMethods, pluginEvents } from "./plugins.js";
import { channelMethods, channelEvents } from "./channels.js";
import { routineMethods, routineEvents } from "./routines.js";
import { adminMethods, adminEvents } from "./admin.js";
import { commandMethods } from "./commands.js";
import { toolsetMethods } from "./toolsets.js";

export * from "./session.js";
export * from "./chat.js";
export * from "./subagents.js";
export * from "./tasks.js";
export * from "./questions.js";
export * from "./approvals.js";
export * from "./plugins.js";
export * from "./channels.js";
export * from "./routines.js";
export * from "./admin.js";
export * from "./commands.js";
export * from "./toolsets.js";

/**
 * Central method registry. The gateway dispatch layer and typed clients both
 * consume this to find param/result schemas by method name.
 */
export const methodRegistry = {
  ...sessionMethods,
  ...chatMethods,
  ...subagentMethods,
  ...taskMethods,
  ...questionMethods,
  ...approvalMethods,
  ...pluginMethods,
  ...channelMethods,
  ...routineMethods,
  ...adminMethods,
  ...commandMethods,
  ...toolsetMethods,
} as const;

export type MethodName = keyof typeof methodRegistry;

/**
 * Central event registry. Channels and clients use this to find the payload
 * schema for a given event topic.
 */
export const eventRegistry = {
  ...sessionEvents,
  ...chatEvents,
  ...subagentEvents,
  ...taskEvents,
  ...questionEvents,
  ...approvalEvents,
  ...pluginEvents,
  ...channelEvents,
  ...routineEvents,
  ...adminEvents,
} as const;

export type EventName = keyof typeof eventRegistry;

/**
 * Narrow `unknown` params against a method's registered schema.
 * Returns the parsed value or throws the caller's error.
 */
export function parseMethodParams<M extends MethodName>(
  method: M,
  value: unknown,
): z.infer<(typeof methodRegistry)[M]["params"]> {
  const schema = methodRegistry[method].params as z.ZodTypeAny;
  return schema.parse(value);
}

export function parseEventData<E extends EventName>(
  event: E,
  value: unknown,
): z.infer<(typeof eventRegistry)[E]> {
  const schema = eventRegistry[event] as z.ZodTypeAny;
  return schema.parse(value);
}
