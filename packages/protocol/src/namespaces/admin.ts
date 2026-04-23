import { z } from "zod";

export const adminHealthParams = z.object({}).optional();
export const adminHealthResult = z.object({
  ok: z.boolean(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  sessions: z.object({
    active: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export const adminConfigParams = z.object({}).optional();
export const adminConfigResult = z.object({
  primary: z.object({ model: z.string() }),
  fallbacks: z.array(z.object({ model: z.string() })),
  providers: z.array(z.string()),
  subagents: z.object({
    maxConcurrentGlobal: z.number().int().positive(),
    maxConcurrentPerParent: z.number().int().positive(),
    maxTreeDepth: z.number().int().positive(),
  }),
  approvals: z.object({
    requireForTags: z.array(z.string()),
    timeoutSeconds: z.number().int().positive(),
  }),
});

export const adminModelsParams = z.object({}).optional();
export const adminModelsResult = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      provider: z.string(),
      contextWindow: z.number().int().nonnegative(),
      notes: z.string().optional(),
    }),
  ),
});

export const tokenScopeSchema = z.string();

export const tokenRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  scopes: z.array(tokenScopeSchema),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type TokenRecord = z.infer<typeof tokenRecordSchema>;

export const adminTokensCreateParams = z.object({
  label: z.string().min(1),
  scopes: z.array(tokenScopeSchema).min(1),
});
export const adminTokensCreateResult = z.object({
  token: tokenRecordSchema,
  secret: z.string(), // shown once
});

export const adminTokensRevokeParams = z.object({ id: z.string() });
export const adminTokensRevokeResult = z.object({ token: tokenRecordSchema });

export const adminMethods = {
  "admin.health": { params: adminHealthParams, result: adminHealthResult },
  "admin.config": { params: adminConfigParams, result: adminConfigResult },
  "admin.models": { params: adminModelsParams, result: adminModelsResult },
  "admin.tokens.create": { params: adminTokensCreateParams, result: adminTokensCreateResult },
  "admin.tokens.revoke": { params: adminTokensRevokeParams, result: adminTokensRevokeResult },
} as const;

export const logLineEvent = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  time: z.string(),
  source: z.string().optional(),
});

export const adminEvents = {
  "log.line": logLineEvent,
} as const;
