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
import type { PluginRecord, PluginUiContribution, SubagentDefinition } from "@squad/protocol";
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
  /**
   * Optional notifier called whenever a plugin's record changes (loaded,
   * enabled/disabled, configured, reloaded). The gateway wires this to
   * publish `plugins.changed` so dashboards live-update.
   */
  onPluginChanged?: (record: PluginRecord) => void;
}

export interface LoadedPlugin {
  descriptor: PluginDescriptor;
  source: string;
  config: Record<string, unknown>;
  enabled: boolean;
  installedAt: string;
  uiContributions: PluginUiContribution[];
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
    const uiContributions: PluginUiContribution[] = [];
    const api = this.apiFor(config, uiContributions);
    const cleanup = await descriptor.register(api);
    const entry: LoadedPlugin = {
      descriptor,
      source: entryPath,
      config,
      enabled: true,
      installedAt: new Date().toISOString(),
      uiContributions,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
    this.loaded.set(descriptor.id, entry);
    this.deps.logger.info({ id: descriptor.id, kinds: descriptor.kinds }, "plugin loaded");
    this.deps.onPluginChanged?.(this.toRecord(entry));
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

  /**
   * Toggle enabled flag without unloading. The contributions stay registered
   * (channels keep running, etc.) — disabling is metadata only for v1. Actual
   * lifecycle teardown is the caller's job; for a hard reset, use reload().
   */
  setEnabled(id: string, enabled: boolean): PluginRecord | null {
    const entry = this.loaded.get(id);
    if (!entry) return null;
    entry.enabled = enabled;
    const rec = this.toRecord(entry);
    this.deps.onPluginChanged?.(rec);
    return rec;
  }

  setConfig(id: string, config: Record<string, unknown>): PluginRecord | null {
    const entry = this.loaded.get(id);
    if (!entry) return null;
    entry.config = config;
    const rec = this.toRecord(entry);
    this.deps.onPluginChanged?.(rec);
    return rec;
  }

  /**
   * Unload then re-import. Tries to preserve enabled/config from the prior
   * entry. Returns the fresh record on success.
   */
  async reload(id: string): Promise<PluginRecord | null> {
    const entry = this.loaded.get(id);
    if (!entry) return null;
    const { source, config, enabled } = entry;
    await this.unload(id);
    const fresh = await this.load(source, config);
    fresh.enabled = enabled;
    const rec = this.toRecord(fresh);
    this.deps.onPluginChanged?.(rec);
    return rec;
  }

  list(): PluginDescriptor[] {
    return Array.from(this.loaded.values()).map((e) => e.descriptor);
  }

  records(): PluginRecord[] {
    return Array.from(this.loaded.values()).map((e) => this.toRecord(e));
  }

  recordFor(id: string): PluginRecord | null {
    const entry = this.loaded.get(id);
    return entry ? this.toRecord(entry) : null;
  }

  private toRecord(entry: LoadedPlugin): PluginRecord {
    return {
      id: entry.descriptor.id,
      name: entry.descriptor.name,
      version: entry.descriptor.version,
      kinds: entry.descriptor.kinds,
      enabled: entry.enabled,
      ...(Object.keys(entry.config).length > 0 ? { config: entry.config } : {}),
      source: entry.source,
      installedAt: entry.installedAt,
      uiContributions: [...entry.uiContributions],
    };
  }

  private apiFor(
    config: Record<string, unknown>,
    uiBuf: PluginUiContribution[],
  ): GatewayAPI {
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
      ui: {
        contribute: (contribution: PluginUiContribution) => {
          uiBuf.push(contribution);
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
