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
