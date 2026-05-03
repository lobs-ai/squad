import type { BaseTool, ToolGroup } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { PluginUiContribution, SubagentDefinition } from "@squad/protocol";
import type { ZodTypeAny } from "zod";

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
  /**
   * Optional Zod schema describing the plugin's `config` shape. When present,
   * the gateway:
   *   - validates the user-provided config in `plugins.install` before calling
   *     `register(api)`,
   *   - exposes a JSON-friendly field list via `plugins.describe` so the
   *     dashboard / CLI can render a configure form,
   *   - auto-generates values for any field tagged with `secret(true)`
   *     (see `pluginSecretField`) before calling `register`.
   *
   * Plugins without a schema keep working unchanged — install just hands
   * `config` straight to `register`.
   */
  configSchema?: ZodTypeAny;
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
    | {
        kind: "prompt";
        messages: Array<{ role: "user" | "system"; text: string }>;
        skills?: string[];
      }
    | { kind: "script"; command: string; args?: string[]; cwd?: string }
    | {
        kind: "scriptThenPrompt";
        command: string;
        args?: string[];
        cwd?: string;
        prompt: {
          messages: Array<{ role: "user" | "system"; text: string }>;
          skills?: string[];
        };
      };
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
  /**
   * Where to send the routine's output. Built-in kinds (`silent`,
   * `dashboard`, `discord`) are typed precisely; arbitrary `{ kind, ... }`
   * objects are accepted so plugin-registered handlers (slack, webhook,
   * email, …) can be targeted without changing the protocol. The string
   * shorthand `"silent"` / `"dashboard"` is also accepted.
   */
  delivery?:
    | "silent"
    | "dashboard"
    | { kind: "silent" }
    | { kind: "dashboard" }
    | { kind: "discord"; channelId: string; guildId?: string }
    | { kind: string; [extra: string]: unknown };
}

/**
 * A skill is a **parameterized subagent definition** — system prompt, tool
 * subset, model, token budget, plus a structured input schema. Plugins
 * register skills via `api.skills.register({...})`; the host turns each
 * skill into a registered subagent with name = `skill:<id>` so the agent
 * can invoke it via `spawn_subagent({ subagent: "skill:research", input: {...} })`.
 *
 * The legacy "system prompt fragment" form (`name + systemPromptFragment`)
 * is kept for back-compat — the host injects fragments into the system
 * prompt the way it always did. Plugins should migrate to the structured
 * form when they need their own model / tool subset / input schema.
 */
export interface SkillDescriptor {
  name: string;
  /** Prompt snippet injected into the system prompt when the skill is active. */
  systemPromptFragment?: string;
  /** Human-readable description — surfaced in subagent listings. */
  description?: string;
  /** Model id the skill runs against. Inherits gateway default when omitted. */
  model?: string;
  /** Tool ids the skill is allowed to use. Empty = inherit parent tools. */
  tools?: string[];
  /** Toolset bundles unioned with `tools`. */
  toolsets?: string[];
  /** SOUL.md preface seeded the first time the underlying subagent runs. */
  systemPrompt?: string;
  /** JSON Schema for the structured `input` payload. */
  inputSchema?: Record<string, unknown>;
  /** Hard limits — same shape as `SubagentDefinition.limits`. */
  limits?: {
    maxTokens?: number;
    maxToolCalls?: number;
    timeoutMs?: number;
  };
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
  payloadKind: "prompt" | "script" | "scriptThenPrompt";
  output?: string;
  tokens?: { in: number; out: number };
  silentGate: boolean;
}
export type PluginDeliveryHandler = (
  ctx: DeliveryHandlerInput,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * HTTP route registration for plugins. The handler runs against the same
 * Node `http.IncomingMessage` / `http.ServerResponse` the gateway already
 * dispatches over — plugins are responsible for writing a response (status,
 * headers, body) before returning. Anything thrown is logged and turned
 * into a 500.
 *
 * Routes are matched after the gateway's own paths (`/health`, `/pair/*`,
 * webhooks, `/v1/*`, dashboard statics) but before the static-file 404, so
 * a plugin can claim e.g. `/oauth/google/*` without colliding with the
 * built-ins. Path matching is exact unless the path ends in `/*`, in which
 * case it's a prefix match.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface PluginHttpHandlerCtx {
  /** The full request URL parsed against `http://host`. */
  url: URL;
  /** Path segments captured by a wildcard route (`/foo/*` → `["bar", "baz"]` for `/foo/bar/baz`). */
  wildcardPath: string;
  /** Lower-cased headers — duplicates collapse to the last value. */
  headers: Record<string, string>;
  /** Raw body bytes; resolves once the request stream ends. */
  readBody: () => Promise<Buffer>;
  /** Convenience helper: parse the raw body as JSON, throws on invalid JSON. */
  readJson: () => Promise<unknown>;
}

export type PluginHttpHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  ctx: PluginHttpHandlerCtx,
) => Promise<void> | void;

type AnyTool = BaseTool<Record<string, unknown>>;

/**
 * Hook a plugin can register to handle a non-Squad-native subagent runtime
 * (Claude Code, Codex, Gemini, …). The gateway hands the structured spawn
 * input; the runtime spawns the external agent and streams text back.
 */
export interface SubagentRuntimeRegistration {
  id: string;
  run(input: {
    prompt: string;
    model: string;
    allowedTools: string[];
    cwd: string;
    definition: SubagentDefinition;
    signal: AbortSignal;
    onTextChunk?: (delta: string) => void;
  }): Promise<{
    output: string;
    succeeded: boolean;
    inputTokens: number;
    outputTokens: number;
    detail?: Record<string, unknown>;
  }>;
}

export interface GatewayAPI {
  tools: { register(tool: AnyTool): void };
  /**
   * Tool groups contributed by the plugin. The gateway exposes lazy groups
   * in the `<tool_groups>` system-prompt index — registering one here lets
   * the plugin add a group whose schemas become available to the agent only
   * when it calls `describe_tool_group({ groups: "<name>" })`. Plugins
   * usually pair this with `tools.register(...)` for the same names.
   */
  toolGroups: { register(group: ToolGroup): void };
  providers: { register(name: string, client: LLMClient): void };
  subagents: { register(def: SubagentDefinition): void };
  /**
   * External-runtime adapters. Plugins register an adapter under an id;
   * subagent definitions opt in via `runtime: <id>`. Most plugins won't
   * touch this — it's the path for ACP-bound runtimes only.
   */
  subagentRuntimes: { register(runtime: SubagentRuntimeRegistration): void };
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
   * HTTP routes contributed by the plugin. The gateway mounts each route on
   * its primary HTTP listener so plugins can implement OAuth callbacks,
   * webhook receivers, embed-from-the-browser endpoints, etc. without
   * standing up their own server.
   *
   * Path is exact-match unless it ends in `/*` (prefix match). Method is
   * matched verbatim. Plugins must declare the `http` permission in their
   * manifest to register routes.
   */
  http: {
    register(method: HttpMethod, path: string, handler: PluginHttpHandler): void;
  };
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
