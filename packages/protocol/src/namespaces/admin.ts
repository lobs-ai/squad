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

// Full-tree read + path-scoped writes used by the Settings UI. The result is
// intentionally untyped (`unknown`) on the wire — the gateway re-validates
// every write against the canonical zod schema, and the dashboard renders
// known sections explicitly. `editable: false` means the gateway has no
// SQUAD_CONFIG file to write to (test/ephemeral deployments) — the SPA hides
// edit affordances in that case.
export const adminConfigFullParams = z.object({}).optional();
export const adminConfigFullResult = z.object({
  config: z.record(z.unknown()),
  editable: z.boolean(),
  path: z.string().nullable(),
});

export const adminConfigSetParams = z.object({
  path: z.string().min(1),
  value: z.unknown(),
});
export const adminConfigSetResult = z.object({
  config: z.record(z.unknown()),
});

export const adminConfigUnsetParams = z.object({
  path: z.string().min(1),
});
export const adminConfigUnsetResult = z.object({
  config: z.record(z.unknown()),
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

// Tool catalog — every tool currently registered with the gateway, with the
// tags it carries. The dashboard's approvals editor uses this to render a
// searchable picker instead of asking the user to type tool / tag names.
export const toolCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
});
export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>;

export const adminToolsCatalogParams = z.object({}).optional();
export const adminToolsCatalogResult = z.object({
  tools: z.array(toolCatalogEntrySchema),
});

// ── Identity + peers ─────────────────────────────────────────────────────
//
// These exist so a single dashboard SPA can serve every squad. `identity`
// names the squad it just connected to; `peers` enumerates siblings. Both
// are best-effort: a gateway running outside docker, or without a registry
// file, returns a single-element peer list (just itself).

export const adminIdentityParams = z.object({}).optional();
export const adminIdentityResult = z.object({
  name: z.string(),
  port: z.number().int().nonnegative(),
  host: z.string(),
  build: z.string(),
  version: z.string(),
  startedAt: z.string(),
});

export const peerStatusSchema = z.enum(["healthy", "starting", "stopped", "unhealthy", "unknown"]);
export type PeerStatus = z.infer<typeof peerStatusSchema>;

export const peerRecordSchema = z.object({
  name: z.string(),
  port: z.number().int().nonnegative(),
  url: z.string(),
  status: peerStatusSchema,
  build: z.string().nullable(),
  startedAt: z.string().nullable(),
});
export type PeerRecord = z.infer<typeof peerRecordSchema>;

export const adminPeersParams = z.object({}).optional();
export const adminPeersResult = z.object({ peers: z.array(peerRecordSchema) });

export const peersChangedEvent = z.object({ peers: z.array(peerRecordSchema) });

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

// ── Browser pairing ─────────────────────────────────────────────────────
//
// Mirror of the Discord pairing flow. The dashboard gate hits an
// unauthenticated HTTP endpoint to start a pairing and gets a short code;
// an operator with CLI access calls `admin.pair.approve` to mint a per-
// browser token; the browser polls until the token is ready.

export const pairingStatusSchema = z.enum([
  "pending",
  "approved",
  "claimed",
  "expired",
  "cancelled",
]);
export type PairingStatus = z.infer<typeof pairingStatusSchema>;

export const pairingViewSchema = z.object({
  code: z.string(),
  label: z.string(),
  scopes: z.array(z.string()),
  status: pairingStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  /** Set when the browser has consumed the token. Null otherwise. */
  claimedAt: z.string().nullable().default(null),
  /** True when the pairing is on disk and survives a gateway restart. */
  persistent: z.boolean().default(false),
});
export type PairingView = z.infer<typeof pairingViewSchema>;

export const adminPairListParams = z.object({}).optional();
export const adminPairListResult = z.object({ pairings: z.array(pairingViewSchema) });

export const adminPairApproveParams = z.object({ code: z.string().min(3) });
export const adminPairApproveResult = z.object({ pairing: pairingViewSchema });

export const adminPairCancelParams = z.object({ code: z.string().min(3) });
export const adminPairCancelResult = z.object({ pairing: pairingViewSchema });

export const pairRequestedEvent = z.object({ pairing: pairingViewSchema });
export const pairApprovedEvent = z.object({ pairing: pairingViewSchema });
export const pairCancelledEvent = z.object({ pairing: pairingViewSchema });

export const adminMethods = {
  "admin.health": { params: adminHealthParams, result: adminHealthResult },
  "admin.config": { params: adminConfigParams, result: adminConfigResult },
  "admin.config.full": { params: adminConfigFullParams, result: adminConfigFullResult },
  "admin.config.set": { params: adminConfigSetParams, result: adminConfigSetResult },
  "admin.config.unset": { params: adminConfigUnsetParams, result: adminConfigUnsetResult },
  "admin.models": { params: adminModelsParams, result: adminModelsResult },
  "admin.tools.catalog": { params: adminToolsCatalogParams, result: adminToolsCatalogResult },
  "admin.identity": { params: adminIdentityParams, result: adminIdentityResult },
  "admin.peers": { params: adminPeersParams, result: adminPeersResult },
  "admin.tokens.create": { params: adminTokensCreateParams, result: adminTokensCreateResult },
  "admin.tokens.revoke": { params: adminTokensRevokeParams, result: adminTokensRevokeResult },
  "admin.pair.list": { params: adminPairListParams, result: adminPairListResult },
  "admin.pair.approve": { params: adminPairApproveParams, result: adminPairApproveResult },
  "admin.pair.cancel": { params: adminPairCancelParams, result: adminPairCancelResult },
} as const;

export const logLineEvent = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  time: z.string(),
  source: z.string().optional(),
});

/**
 * One LLM-call worth of structured tracing — emitted after each agent loop
 * iteration so dashboards / observability tools can render a flame graph.
 *
 * Topic: `trace.step/<sessionId>` (per-session) so subscribers can scope
 * their listeners. Cumulative usage is on the event so a late subscriber
 * still sees the running total.
 */
export const traceStepEvent = z.object({
  sessionId: z.string(),
  runId: z.string(),
  /** Monotonic per-run step counter starting at 1. */
  step: z.number().int().nonnegative(),
  model: z.string(),
  /** Wall-clock duration of the LLM call in ms. */
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Cumulative tokens for the run so far. */
  cumulative: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
  /** Tool calls the LLM emitted *in this turn*. Empty for end-turn responses. */
  toolCalls: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Cache hit ratio over input tokens (0..1). 0 when no cache info. */
  cacheHitRatio: z.number().min(0).max(1),
  occurredAt: z.string(),
});

export const adminEvents = {
  "log.line": logLineEvent,
  "peers.changed": peersChangedEvent,
  "pair.requested": pairRequestedEvent,
  "pair.approved": pairApprovedEvent,
  "pair.cancelled": pairCancelledEvent,
  "trace.step": traceStepEvent,
} as const;
