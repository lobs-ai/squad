import { resolve as resolvePath, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GatewayAPI,
  PluginDescriptor,
  RoutineDescriptor,
  SkillDescriptor,
  ApprovalPolicy,
  ChannelHandle,
} from "@squad/plugin-sdk";
import type { ToolRegistry, BaseTool } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { SubagentDefinition } from "@squad/protocol";
import type { SubagentRegistry } from "../subagents/registry.js";
import type { Logger } from "../logger.js";

type AnyTool = BaseTool<Record<string, unknown>>;

export interface PluginHostDeps {
  toolRegistry: ToolRegistry;
  subagentRegistry: SubagentRegistry;
  logger: Logger;
  /** Providers registry — a simple Map<name, LLMClient> the gateway wires up. */
  providers: Map<string, LLMClient>;
  /** Routines collected so the scheduler can pick them up. */
  routines: RoutineDescriptor[];
  /** Skills (prompt snippets) collected for the run assembly layer. */
  skills: SkillDescriptor[];
  /** Approval policies registered in cascade order. */
  approvalPolicies: ApprovalPolicy[];
  /** Channel lifecycles collected from plugins of kind "channel". */
  channels: ChannelHandle[];
}

export interface LoadedPlugin {
  descriptor: PluginDescriptor;
  cleanup: (() => void | Promise<void>) | undefined;
}

export class PluginHost {
  private readonly loaded: Map<string, LoadedPlugin> = new Map();

  constructor(private readonly deps: PluginHostDeps) {}

  async load(entryPath: string, config: Record<string, unknown> = {}): Promise<LoadedPlugin> {
    // Accept three forms:
    //   - bare specifier ("@squad/channel-discord/plugin") → pass to import()
    //     so Node's module resolution handles it (workspace, node_modules)
    //   - relative path ("./extensions/foo.js") → resolve against cwd
    //   - absolute path → use as-is
    const looksLikePath =
      isAbsolute(entryPath) ||
      entryPath.startsWith("./") ||
      entryPath.startsWith("../");
    const specifier = looksLikePath
      ? pathToFileURL(isAbsolute(entryPath) ? entryPath : resolvePath(process.cwd(), entryPath)).href
      : entryPath;
    const mod = (await import(specifier)) as { default?: PluginDescriptor };
    const descriptor = mod.default;
    if (!descriptor || typeof descriptor.register !== "function") {
      throw new Error(`plugin at ${entryPath} has no valid default export`);
    }
    const api = this.apiFor(config);
    const cleanup = await descriptor.register(api);
    const entry: LoadedPlugin = {
      descriptor,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
    this.loaded.set(descriptor.id, entry);
    this.deps.logger.info({ id: descriptor.id, kinds: descriptor.kinds }, "plugin loaded");
    return entry;
  }

  async unload(id: string): Promise<void> {
    const entry = this.loaded.get(id);
    if (!entry) return;
    if (entry.cleanup) {
      try {
        await entry.cleanup();
      } catch (err) {
        this.deps.logger.error({ err, id }, "plugin cleanup threw");
      }
    }
    this.loaded.delete(id);
  }

  list(): PluginDescriptor[] {
    return Array.from(this.loaded.values()).map((e) => e.descriptor);
  }

  private apiFor(config: Record<string, unknown>): GatewayAPI {
    return {
      tools: {
        register: (tool: AnyTool) => {
          this.deps.toolRegistry.register(tool);
        },
      },
      providers: {
        register: (name: string, client: LLMClient) => {
          this.deps.providers.set(name, client);
        },
      },
      subagents: {
        register: (def: SubagentDefinition) => {
          this.deps.subagentRegistry.register(def);
        },
      },
      routines: {
        register: (def: RoutineDescriptor) => {
          this.deps.routines.push(def);
        },
      },
      skills: {
        register: (skill: SkillDescriptor) => {
          this.deps.skills.push(skill);
        },
      },
      approvalPolicies: {
        register: (policy: ApprovalPolicy) => {
          this.deps.approvalPolicies.push(policy);
        },
      },
      channels: {
        register: (channel: ChannelHandle) => {
          this.deps.channels.push(channel);
        },
      },
      logger: {
        info: (msg, meta) => this.deps.logger.info({ ...(meta as object) }, msg),
        warn: (msg, meta) => this.deps.logger.warn({ ...(meta as object) }, msg),
        error: (msg, meta) => this.deps.logger.error({ ...(meta as object) }, msg),
      },
      config,
    };
  }
}
