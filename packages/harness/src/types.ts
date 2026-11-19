/**
 * @squad/harness — the contract
 *
 * The seam between Squad and an external agent harness (Claude Agent SDK /
 * Codex SDK). Squad owns the conversation, persistence, primitives, and
 * clients; the harness owns model-calling and the agent loop.
 *
 * Both adapters normalize onto the one `HarnessEvent` union below — that union
 * is the *only* place harness differences are absorbed (the lockstep boundary).
 * Callers (notably the gateway's runChatTurn) program against `HarnessSession`
 * + `HarnessCaps`, never against `kind`.
 */

export type HarnessKind = "claude" | "codex";

/**
 * Where the current turn is rendering. Mirrors the gateway's RenderContext
 * surface so the approval engine and prompt fragments line up. Kept as a local
 * literal union to keep this package dependency-free.
 */
export type HarnessSurface =
  | "dashboard"
  | "cli"
  | "channel"
  | "subagent"
  | "cron-isolated";

export interface HarnessAuth {
  /**
   * `subscription` = Claude.ai / ChatGPT OAuth token (single-user self-host).
   * `api-key` = token-billed API key. The manager carries both and picks by
   * deployment; subscription must not be used to serve other users.
   */
  mode: "subscription" | "api-key";
  /** CLAUDE_CODE_OAUTH_TOKEN | ANTHROPIC_API_KEY | OPENAI_API_KEY | codex token. */
  token: string;
  /** Custom OpenAI-format endpoint (Codex) or ANTHROPIC_BASE_URL (Claude). */
  baseUrl?: string;
  provider?: "anthropic" | "bedrock" | "vertex" | "openai" | "openai-compatible";
}

/**
 * Capability flags. Adapters genuinely differ; this is how `runChatTurn` and
 * the warm pool make decisions without branching on the harness kind.
 */
export interface HarnessCaps {
  /** Squad MCP tools run in-process (Claude SDK) vs. a served/bridged endpoint. */
  inProcessMcp: boolean;
  /** Per-tool-call approval callback available (Claude canUseTool) vs. policy. */
  perCallApproval: boolean;
  /** Emits extended-thinking deltas. */
  thinking: boolean;
  /** Can resume a prior session by id in a fresh process. Both: true. */
  resumeAcrossProcess: boolean;
}

/**
 * Minimal tool shape exposed to the harness as an MCP tool. Structurally
 * compatible with @squad/llm's `ToolDefinition` (name / description /
 * input_schema) so the gateway can map its registry entries with a thin
 * adapter and no type coupling back into this package.
 */
export interface HarnessToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Runs a squad primitive tool the harness invoked, returning the textual
 * result forwarded back. Mirrors the executor the claude-cli MCP bridge
 * already uses, so the gateway can wire `toolRegistry.execute` straight in.
 */
export type SquadToolExecutor = (
  name: string,
  params: Record<string, unknown>,
) => Promise<string>;

/** The squad primitives exposed to the harness this turn, plus how to run them. */
export interface SquadToolset {
  tools: HarnessToolDef[];
  execute: SquadToolExecutor;
}

export interface HarnessAttachment {
  kind: "image" | "file";
  /** Path on the agent workspace, when the file already lives there. */
  path?: string;
  mediaType?: string;
  /** Base64 payload when inlined rather than referenced by path. */
  data?: string;
}

export interface HarnessTurnInput {
  text: string;
  attachments?: HarnessAttachment[];
}

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
  costUsd?: number;
}

/** Everything needed to open or resume a harness session. */
export interface HarnessStartSpec {
  /** The squad session this binds to. */
  sessionId: string;
  /** Harness-side session/thread id to resume; undefined = a fresh session. */
  resume?: string;
  /** Model string in the harness's own namespace (e.g. "claude-sonnet-4-5"). */
  model: string;
  auth: HarnessAuth;
  /** Agent workspace — the harness's cwd. */
  cwd: string;
  /**
   * Isolated config / transcript / credential dir for this squad. Points the
   * harness's own store (CLAUDE_CONFIG_DIR / ~/.codex equivalent) inside the
   * squad data_dir so nothing leaks into ~/.claude or ~/.codex.
   */
  configDir: string;
  /**
   * Appended to the harness's own (native) system prompt. MUST be stable
   * across turns of a session — SOUL/USER core files + eager memory +
   * channel-reply contract + runtime-env. Per-turn memory *retrieval* is a
   * tool (pull), never injected here, so a warm session stays reusable.
   */
  appendSystemPrompt: string;
  /** Squad primitives to expose as MCP tools this turn. */
  squadTools: SquadToolset;
  /** Harness-native leaf tools to enable (Read / Edit / Bash / Grep / Web …). */
  allowedNativeTools: string[];
  /** Hard wall-clock cap for a single turn, in seconds. */
  turnTimeoutSec?: number;
  surface: HarnessSurface;
}

export type HarnessStopReason =
  | "end_turn"
  | "max_turns"
  | "cancelled"
  | "timeout"
  | "error";

/**
 * A normalized event from a harness turn. This union is the lockstep boundary:
 * every adapter maps its native stream onto exactly these shapes, and the
 * gateway ingests only these.
 */
export type HarnessEvent =
  | { t: "session.init"; harnessSessionId: string; model: string; tools: string[] }
  | { t: "turn.start" }
  | { t: "text.delta"; text: string }
  | { t: "thinking.delta"; text: string }
  | { t: "tool.start"; id: string; name: string; input: unknown; parentId?: string }
  | { t: "tool.end"; id: string; output: unknown; isError: boolean }
  | { t: "turn.end"; stopReason: HarnessStopReason; usage: HarnessUsage }
  | { t: "notice"; kind: "api_retry" | "warning"; detail: unknown }
  | { t: "error"; category: string; message: string; retryable: boolean };

/** A live (or resumable) harness conversation bound to one squad session. */
export interface HarnessSession {
  readonly kind: HarnessKind;
  readonly caps: HarnessCaps;
  readonly sessionId: string;
  /** Stream one turn. The async iterable completes when the turn ends. */
  runTurn(input: HarnessTurnInput): AsyncIterable<HarnessEvent>;
  /** Harness-side id, available after the first `session.init`. Persist it. */
  harnessSessionId(): string | undefined;
  /** Cooperatively stop the in-flight turn. */
  interrupt(): Promise<void>;
  /** Tear down — warm-pool eviction or gateway shutdown. */
  close(): Promise<void>;
}

export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * Per-tool-call approval bridge to Squad's approval engine. Adapters with
 * `caps.perCallApproval` invoke this for every tool call (native + MCP);
 * adapters without it set a coarse policy at start instead.
 */
export type ApprovalHook = (call: {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  surface: HarnessSurface;
}) => Promise<ApprovalDecision>;

/** Opens / resumes sessions for one harness kind. */
export interface HarnessFactory {
  readonly kind: HarnessKind;
  open(spec: HarnessStartSpec, approval: ApprovalHook): Promise<HarnessSession>;
}
