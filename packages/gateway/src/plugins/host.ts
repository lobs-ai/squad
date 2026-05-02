import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GatewayAPI,
  PluginDescriptor,
  PluginManifest,
  PluginPermission,
  RoutineDescriptor,
  SkillDescriptor,
  ApprovalPolicy,
  ChannelHandle,
  SlashCommandDescriptor,
  ToolsetDescriptor,
  PluginDeliveryHandler,
  PluginHttpHandler,
  HttpMethod,
} from "@squad/plugin-sdk";
import type { SubagentRuntimeRegistry } from "../subagents/runtime.js";
import { parsePluginManifest, satisfiesRequires } from "@squad/plugin-sdk";
import type { ToolRegistry, ToolGroupRegistry, ToolGroup, BaseTool } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { PluginRecord, PluginUiContribution, SubagentDefinition } from "@squad/protocol";
import type { SubagentRegistry } from "../subagents/registry.js";
import type { Logger } from "../logger.js";

type AnyTool = BaseTool<Record<string, unknown>>;

export interface PluginHostDeps {
  toolRegistry: ToolRegistry;
  /**
   * Tool group registry. Plugins can contribute lazy groups via
   * `api.toolGroups.register(...)`; the gateway exposes them in the
   * `<tool_groups>` system-prompt index alongside built-in groups.
   */
  toolGroups: ToolGroupRegistry;
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
  /** Optional registry for non-Squad-native subagent runtimes (ACP-bound). */
  subagentRuntimes?: SubagentRuntimeRegistry;
  /** Channel lifecycles collected from plugins of kind "channel". */
  channels: ChannelHandle[];
  /** Slash commands contributed by plugins. Surfaced via commands.list. */
  commands: SlashCommandDescriptor[];
  /** Toolset bundles. Surfaced via toolsets.list / spawn_subagent. */
  toolsets: ToolsetDescriptor[];
  /**
   * Delivery handlers, keyed by `delivery.kind`. The gateway forwards this
   * to its DeliveryRegistry on register.
   */
  registerDelivery: (kind: string, handler: PluginDeliveryHandler) => void;
  /**
   * Optional HTTP route registry. The gateway hands each plugin-registered
   * route to its server's request dispatcher; absent in tests / ephemeral
   * deployments where no HTTP listener is wired up.
   */
  registerHttpRoute?: (
    method: HttpMethod,
    path: string,
    handler: PluginHttpHandler,
  ) => void;
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
  /** Manifest discovered next to the entry, if present. */
  manifest?: PluginManifest;
  config: Record<string, unknown>;
  enabled: boolean;
  installedAt: string;
  uiContributions: PluginUiContribution[];
  cleanup: (() => void | Promise<void>) | undefined;
}

export class PluginHost {
  private readonly loaded: Map<string, LoadedPlugin> = new Map();
  /** Per-call cache-busting stamp used by reload(). Cleared after each load. */
  private reloadStamp: number | null = null;

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
    const absolute = looksLikePath
      ? isAbsolute(entryPath)
        ? entryPath
        : resolvePath(process.cwd(), entryPath)
      : null;
    const manifest = absolute ? loadManifestNear(absolute) : null;

    // Validate `requires` before importing, so missing prerequisites surface
    // a clear error rather than a cryptic runtime crash from inside the plugin.
    if (manifest) {
      for (const req of manifest.requires) {
        const ok = Array.from(this.loaded.values()).some((p) =>
          satisfiesRequires(req, {
            id: p.descriptor.id,
            version: p.descriptor.version,
          }),
        );
        if (!ok) {
          throw new Error(
            `plugin "${manifest.id}" requires "${req}" which is not loaded`,
          );
        }
      }
    }

    const baseSpecifier = looksLikePath
      ? pathToFileURL(absolute!).href
      : entryPath;
    // Reload-busting: when this is a reload (not a cold load), append a
    // timestamp query so dynamic import gives us the fresh module rather
    // than the cached one. The host injects `_reload` via load() during a
    // reload so cold loads stay cache-friendly.
    const specifier = this.reloadStamp
      ? `${baseSpecifier}${baseSpecifier.includes("?") ? "&" : "?"}t=${this.reloadStamp}`
      : baseSpecifier;
    const mod = (await import(specifier)) as { default?: PluginDescriptor };
    const descriptor = mod.default;
    if (!descriptor || typeof descriptor.register !== "function") {
      throw new Error(`plugin at ${entryPath} has no valid default export`);
    }
    const uiContributions: PluginUiContribution[] = [];
    const api = this.apiFor(config, uiContributions, manifest?.permissions);
    const cleanup = await descriptor.register(api);
    const entry: LoadedPlugin = {
      descriptor,
      source: entryPath,
      ...(manifest ? { manifest } : {}),
      config,
      enabled: true,
      installedAt: new Date().toISOString(),
      uiContributions,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
    this.loaded.set(descriptor.id, entry);
    this.deps.logger.info(
      {
        id: descriptor.id,
        kinds: descriptor.kinds,
        manifest: manifest ? "present" : "absent",
      },
      "plugin loaded",
    );
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
    this.reloadStamp = Date.now();
    try {
      const fresh = await this.load(source, config);
      fresh.enabled = enabled;
      const rec = this.toRecord(fresh);
      this.deps.onPluginChanged?.(rec);
      return rec;
    } finally {
      this.reloadStamp = null;
    }
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
    permissions?: PluginPermission[],
  ): GatewayAPI {
    const allow = (ns: PluginPermission): boolean => {
      // No declared permissions → unrestricted access (back-compat).
      if (!permissions) return true;
      return permissions.includes(ns);
    };
    const denied = (ns: PluginPermission): never => {
      throw new Error(
        `plugin tried to register into "${ns}" without declaring it in manifest.permissions`,
      );
    };
    return {
      tools: {
        register: (tool: AnyTool) => {
          if (!allow("tools")) denied("tools");
          this.deps.toolRegistry.register(tool);
        },
      },
      toolGroups: {
        register: (group: ToolGroup) => {
          if (!allow("toolGroups")) denied("toolGroups");
          this.deps.toolGroups.register(group);
        },
      },
      providers: {
        register: (name: string, client: LLMClient) => {
          if (!allow("providers")) denied("providers");
          this.deps.providers.set(name, client);
        },
      },
      subagents: {
        register: (def: SubagentDefinition) => {
          if (!allow("subagents")) denied("subagents");
          this.deps.subagentRegistry.register(def);
        },
      },
      subagentRuntimes: {
        register: (runtime) => {
          if (!allow("subagents")) denied("subagents");
          this.deps.subagentRuntimes?.register(runtime);
        },
      },
      routines: {
        register: (def: RoutineDescriptor) => {
          if (!allow("routines")) denied("routines");
          this.deps.routines.push(def);
        },
      },
      skills: {
        register: (skill: SkillDescriptor) => {
          if (!allow("skills")) denied("skills");
          this.deps.skills.push(skill);
        },
      },
      approvalPolicies: {
        register: (policy: ApprovalPolicy) => {
          if (!allow("approvalPolicies")) denied("approvalPolicies");
          this.deps.approvalPolicies.push(policy);
        },
      },
      channels: {
        register: (channel: ChannelHandle) => {
          if (!allow("channels")) denied("channels");
          this.deps.channels.push(channel);
        },
      },
      commands: {
        register: (cmd: SlashCommandDescriptor) => {
          if (!allow("commands")) denied("commands");
          this.deps.commands.push(cmd);
        },
      },
      toolsets: {
        register: (def: ToolsetDescriptor) => {
          if (!allow("toolsets")) denied("toolsets");
          this.deps.toolsets.push(def);
        },
      },
      delivery: {
        register: (kind: string, handler: PluginDeliveryHandler) => {
          if (!allow("delivery")) denied("delivery");
          this.deps.registerDelivery(kind, handler);
        },
      },
      http: {
        register: (method: HttpMethod, path: string, handler: PluginHttpHandler) => {
          if (!allow("http")) denied("http");
          if (!this.deps.registerHttpRoute) {
            throw new Error(
              "plugin tried to register an HTTP route but the host has no HTTP server attached",
            );
          }
          this.deps.registerHttpRoute(method, path, handler);
        },
      },
      ui: {
        contribute: (contribution: PluginUiContribution) => {
          if (!allow("ui")) denied("ui");
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

/**
 * Walk up from the entry file looking for `squad.plugin.json`. We only check
 * the entry's own directory and one parent — any deeper and we'd be picking
 * up unrelated manifests in monorepos. Returns null when nothing is found.
 */
function loadManifestNear(entryAbs: string): PluginManifest | null {
  const candidates = [
    join(dirname(entryAbs), "squad.plugin.json"),
    join(dirname(dirname(entryAbs)), "squad.plugin.json"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const raw = JSON.parse(readFileSync(c, "utf8"));
      return parsePluginManifest(raw);
    } catch {
      return null;
    }
  }
  return null;
}
