import type { BaseTool } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { PluginUiContribution, SubagentDefinition } from "@squad/protocol";

export type PluginKind = "tool" | "provider" | "channel" | "skill" | "routine" | "subagent";

/**
 * Slot identifiers a plugin can claim. Mirrors `PluginUiSlot` in the
 * protocol package — re-exported here so plugin authors don't have to
 * import from two places.
 */
export type PluginUiSlot = PluginUiContribution["slot"];

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  kinds: PluginKind[];
  register(api: GatewayAPI): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface RoutineDescriptor {
  name: string;
  cron: string;
  prompt: string;
  model?: string;
  /**
   * Optional structured fields. When omitted, the gateway fills sensible
   * defaults: schedule = cron, payload = prompt, session = new.
   * Plugin authors that need scripts, intervals, or session reuse can
   * supply them directly.
   */
  schedule?:
    | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
    | { kind: "interval"; everyMs: number; anchor?: string }
    | { kind: "once"; at: string };
  payload?:
    | { kind: "prompt"; text: string; skills?: string[] }
    | { kind: "agentTurn"; messages: Array<{ role: "user" | "system"; text: string }> }
    | { kind: "script"; command: string; args?: string[]; cwd?: string };
  session?:
    | { kind: "new" }
    | { kind: "isolated" }
    | { kind: "session"; sessionId: string };
  execution?: {
    model?: string | null;
    fallbacks?: string[];
    toolsAllow?: string[];
    timeoutSec?: number;
  };
  delivery?: "silent" | "dashboard" | { kind: "discord"; channelId: string; guildId?: string };
}

export interface SkillDescriptor {
  name: string;
  /** Prompt snippet injected into the system prompt when the skill is active. */
  systemPromptFragment?: string;
}

export interface ApprovalPolicy {
  decide(ctx: {
    sessionId: string;
    parentSessionId: string | null;
    toolName: string;
    tags: string[];
    input: unknown;
  }): Promise<"approve" | "deny" | "escalate">;
}

/**
 * Lifecycle handle a channel plugin hands to the gateway. `start` is invoked
 * after the HTTP/WS server is listening so channels can open back-connections
 * safely; `stop` runs during shutdown. The gateway itself has no knowledge of
 * specific channel protocols (Discord, Slack, etc.) — channels arrive via
 * plugins.
 */
/**
 * Channel capabilities exposed via the protocol's `channels.list` /
 * `channels.capabilities`. Re-declared here as a plain interface so plugin
 * authors don't have to depend on `@squad/protocol` directly. The gateway
 * fills in defaults when omitted (see channels/registry.ts).
 */
export interface ChannelHandleCapabilities {
  supportsPreview: boolean;
  supportsMultiSelect: boolean;
  supportsFreeText: boolean;
  maxOptions: number;
  supportsImages?: boolean;
  supportsFileUploads?: boolean;
  supportsTaskList?: boolean;
  supportsApprovals?: boolean;
}

export interface ChannelHandle {
  id: string;
  /** Short kind identifier surfaced over the protocol — e.g. "discord". */
  kind?: string;
  /** Human-friendly label. Defaults to `id` when omitted. */
  label?: string;
  /** Capability hints; missing fields default to a conservative baseline. */
  capabilities?: ChannelHandleCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Slash command contributed by a plugin. Surfaced via `commands.list` so
 * each client (CLI, dashboard, channel) can render plugin slash commands
 * without each client shipping its own registry.
 */
export interface SlashCommandDescriptor {
  name: string;          // canonical lowercase, no leading slash
  description: string;
  /** Free-form usage hint, e.g. `/remind <when> <message>`. */
  usage?: string;
  /**
   * Where the command makes sense. `session` shows up in chat REPLs;
   * `global` shows up in dashboard command palettes / global pickers.
   * Default: `["session"]`.
   */
  scope?: Array<"session" | "global">;
}

/**
 * Toolset bundle — a curated `string[]` of tool ids that subagents can pull
 * in by name instead of listing each tool individually. The gateway exposes
 * `toolsets.list` and `toolsets.resolve(name)` for clients; `spawn_subagent`
 * accepts `toolsets?: string[]` and unions them with `tools?: string[]`.
 */
export interface ToolsetDescriptor {
  /** Canonical id, e.g. "@squad/toolset-research". */
  name: string;
  description: string;
  /** Tool ids the toolset bundles. */
  tools: string[];
  /** Tool ids that must already be registered for the toolset to resolve. */
  requires?: string[];
}

/**
 * Delivery handler registered by a channel plugin (or any extension). The
 * gateway routes routine fires whose `delivery.kind` matches `kind` to this
 * handler. Built-in `silent` and `dashboard` kinds are handled by the
 * gateway itself; plugins typically register `discord`, `slack`, or future
 * webhook variants.
 */
export interface DeliveryHandlerInput {
  routineId: string;
  routineName: string;
  delivery: { kind: string } & Record<string, unknown>;
  runId: string;
  sessionId: string | null;
  payloadKind: "prompt" | "agentTurn" | "script";
  output?: string;
  tokens?: { in: number; out: number };
  silentGate: boolean;
}
export type PluginDeliveryHandler = (
  ctx: DeliveryHandlerInput,
) => Promise<{ ok: boolean; error?: string }>;

type AnyTool = BaseTool<Record<string, unknown>>;

export interface GatewayAPI {
  tools: { register(tool: AnyTool): void };
  providers: { register(name: string, client: LLMClient): void };
  subagents: { register(def: SubagentDefinition): void };
  routines: { register(def: RoutineDescriptor): void };
  skills: { register(skill: SkillDescriptor): void };
  approvalPolicies: { register(policy: ApprovalPolicy): void };
  channels: { register(channel: ChannelHandle): void };
  /**
   * Slash commands contributed by the plugin. Surfaced via the
   * `commands.list` protocol method so every client renders them
   * uniformly — no per-client registry.
   */
  commands: { register(cmd: SlashCommandDescriptor): void };
  /**
   * Toolset bundles. See {@link ToolsetDescriptor}. The gateway validates
   * `requires` at registration time and surfaces a clear error to the
   * `spawn_subagent` caller if a toolset references a missing tool.
   */
  toolsets: { register(def: ToolsetDescriptor): void };
  /**
   * Routine delivery fan-out. Channels register a handler for the kind
   * they own (`discord`, `slack`, …). The built-in `silent` and `dashboard`
   * kinds are handled by the gateway and cannot be overridden.
   */
  delivery: { register(kind: string, handler: PluginDeliveryHandler): void };
  /**
   * UI contribution surface. Plugins call `ui.contribute({...})` once per
   * slot they want to claim — the gateway records the metadata and exposes
   * it via `plugins.list`. Actual UI rendering happens client-side; this is
   * declarative metadata only.
   */
  ui: { contribute(contribution: PluginUiContribution): void };
  logger: { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
  config: Record<string, unknown>;
}

/**
 * Define a plugin. Call this with a descriptor object and default-export the
 * result. The gateway's plugin host imports each plugin entry and calls
 * `register(api)` with a scoped `GatewayAPI`.
 */
export function definePlugin(descriptor: PluginDescriptor): PluginDescriptor {
  return descriptor;
}
