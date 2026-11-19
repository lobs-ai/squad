/**
 * @squad/harness — drive an external agent harness (Claude Agent SDK / Codex
 * SDK) as Squad's primary agent loop, behind one normalized contract.
 */

export type {
  ApprovalDecision,
  ApprovalHook,
  HarnessAttachment,
  HarnessAuth,
  HarnessCaps,
  HarnessEvent,
  HarnessFactory,
  HarnessKind,
  HarnessSession,
  HarnessStartSpec,
  HarnessStopReason,
  HarnessSurface,
  HarnessToolDef,
  HarnessTurnInput,
  HarnessUsage,
  SquadToolExecutor,
  SquadToolset,
} from "./types.js";

export { WarmPool } from "./warm-pool.js";
export type { WarmPoolOptions } from "./warm-pool.js";

export {
  runHarnessConformance,
  validateEventStream,
} from "./conformance.js";
export type { ConformanceProbe, ConformanceReport } from "./conformance.js";

// ── Claude adapter ────────────────────────────────────────────────────────────
export { claudeHarnessFactory } from "./claude/harness.js";
export { buildSquadSdkMcpServer, SQUAD_MCP_SERVER_NAME } from "./claude/mcp.js";

// ── Codex adapter ─────────────────────────────────────────────────────────────
export { codexHarnessFactory } from "./codex/harness.js";
