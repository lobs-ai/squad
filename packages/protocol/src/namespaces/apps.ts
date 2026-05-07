import { z } from "zod";

/**
 * Health state of a registered app, derived from periodic GET /squad/health
 * probes. `unknown` is the initial state before the first probe lands.
 */
export const appHealthSchema = z.enum(["unknown", "healthy", "unhealthy", "stopped"]);
export type AppHealth = z.infer<typeof appHealthSchema>;

export const appScopeSchema = z.enum(["persist", "session"]);
export type AppScope = z.infer<typeof appScopeSchema>;

export const appRecordSchema = z.object({
  /** URL slug — must match `[a-z0-9][a-z0-9-]*`. Mounted at `/apps/<name>/`. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  description: z.string().optional(),
  /** Always 127.0.0.1 in v1. Field exists so we can relax later. */
  host: z.string(),
  port: z.number().int().positive(),
  scope: appScopeSchema,
  /** Set when the app was registered as scope:"session" — used for cleanup. */
  sessionId: z.string().optional(),
  /** Set on a mostly-best-effort basis — clients use it to age stale entries. */
  registeredAt: z.number(),
  health: appHealthSchema,
  /** Last health probe ts in ms; null before the first probe finishes. */
  lastProbeAt: z.number().nullable(),
  /** Optional info pulled from `GET /squad/info` (overrides registration meta). */
  info: z.record(z.unknown()).nullable(),
});
export type AppRecord = z.infer<typeof appRecordSchema>;

// -- apps.list --------------------------------------------------------------

export const appsListParams = z.object({}).optional();
export const appsListResult = z.object({ apps: z.array(appRecordSchema) });

// -- apps.get ---------------------------------------------------------------

export const appsGetParams = z.object({ name: z.string() });
export const appsGetResult = z.object({ app: appRecordSchema });

// -- apps.unregister --------------------------------------------------------
//
// Sibling to the agent's `unexpose_app` tool. The dashboard surfaces it on
// orphaned apps (process gone, registration sticking around).

export const appsUnregisterParams = z.object({ name: z.string() });
export const appsUnregisterResult = z.object({ name: z.string() });

export const appMethods = {
  "apps.list": { params: appsListParams, result: appsListResult },
  "apps.get": { params: appsGetParams, result: appsGetResult },
  "apps.unregister": { params: appsUnregisterParams, result: appsUnregisterResult },
} as const;

// -- events -----------------------------------------------------------------

export const appRegisteredEvent = z.object({ app: appRecordSchema });
export const appUnregisteredEvent = z.object({ name: z.string() });
export const appHealthChangedEvent = z.object({
  name: z.string(),
  health: appHealthSchema,
  lastProbeAt: z.number(),
});

export const appEvents = {
  "apps.registered": appRegisteredEvent,
  "apps.unregistered": appUnregisteredEvent,
  "apps.health_changed": appHealthChangedEvent,
} as const;
