import type { BaseTool } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { SubagentDefinition } from "@squad/protocol";

export type PluginKind = "tool" | "provider" | "channel" | "skill" | "routine" | "subagent";

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
export interface ChannelHandle {
  id: string;
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
