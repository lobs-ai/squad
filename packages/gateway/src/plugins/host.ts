import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GatewayAPI,
  PluginDescriptor,
  PluginManifest,
  PluginPermission,
  PluginPromptFragment,
  RoutineDescriptor,
  SkillDescriptor,
  ApprovalPolicy,
  ChannelHandle,
  SlashCommandDescriptor,
  ToolsetDescriptor,
  PluginDeliveryHandler,
  PluginDeliveryMeta,
  PluginHttpHandler,
  HttpMethod,
  PluginRuntimeInfo,
} from "@squad/plugin-sdk";
import type { SubagentRuntimeRegistry } from "../subagents/runtime.js";
import {
  MissingConfigError,
  PluginLoadError,
  parsePluginManifest,
  satisfiesRequires,
} from "@squad/plugin-sdk";
import type { ToolRegistry, ToolGroupRegistry, ToolGroup, BaseTool } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type {
  PluginErrorDetails,
  PluginRecord,
  PluginUiContribution,
  SubagentDefinition,
} from "@squad/protocol";
import type { SubagentRegistry } from "../subagents/registry.js";
import { logger as rootLogger, type Logger } from "../logger.js";

const moduleLog = rootLogger.child({ component: "plugins.host" });

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
  registerDelivery: (
    kind: string,
    handler: PluginDeliveryHandler,
    meta?: PluginDeliveryMeta,
  ) => void;
  /**
   * Optional HTTP route registry. The gateway hands each plugin-registered
   * route to its server's request dispatcher; absent in tests / ephemeral
   * deployments where no HTTP listener is wired up.
   */
  registerHttpRoute?: (
    method: HttpMethod,
    path: string,
    handler: PluginHttpHandler,
    pluginId: string,
  ) => void;
  /**
   * Drop every HTTP route owned by a plugin id. Called by `unload()` so an
   * uninstalled plugin's endpoints stop responding (and don't collide on
   * a later reinstall).
   */
  unregisterHttpRoutesForPlugin?: (pluginId: string) => void;
  /**
   * Plugin-contributed prompt fragments. Each registration is keyed by the
   * registering plugin id so the gateway can drop them when the plugin is
   * unloaded.
   */
  registerPromptFragment?: (
    pluginId: string,
    fragment: PluginPromptFragment,
  ) => void;
  /**
   * Drop every fragment owned by a plugin id. Called by `unload()` so a
   * removed plugin's hints stop appearing in tool descriptions.
   */
  unregisterPromptFragmentsForPlugin?: (pluginId: string) => void;
  /**
   * Optional notifier called whenever a plugin's record changes (loaded,
   * enabled/disabled, configured, reloaded). The gateway wires this to
   * publish `plugins.changed` so dashboards live-update.
   */
  onPluginChanged?: (record: PluginRecord) => void;
  /**
   * Live gateway runtime info forwarded to every plugin via `api.runtime`.
   * The gateway computes this once at boot from the actual server config so
   * plugins can build callback URLs / connect links that reflect the port
   * the gateway is listening on right now — not whatever stale value lives
   * in `process.env.SQUAD_BASE_URL`. Read via the getter on every access so
   * a future hot-rebind of `publicBaseUrl` is picked up without re-loading
   * each plugin.
   */
  runtime: () => PluginRuntimeInfo;
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

/**
 * A plugin entry whose load failed. Tracked separately from `loaded` so the
 * dashboard can surface a row with status="failed" + the error message,
 * instead of the plugin silently disappearing.
 *
 * `id` is best-effort — when the failure was an `import_failed`, we don't
 * have a descriptor and synthesize an id from the source path.
 */
export interface FailedPlugin {
  /** Synthesized from descriptor or source — stable enough for keying UI rows. */
  id: string;
  source: string;
  config: Record<string, unknown>;
  error: PluginErrorDetails;
  installedAt: string;
}

interface PluginContributions {
  toolNames: Set<string>;
  toolGroupNames: Set<string>;
}

export class PluginHost {
  private readonly loaded: Map<string, LoadedPlugin> = new Map();
  /**
   * Plugins that tried to load and threw. Keyed by descriptor id when known,
   * otherwise by source path. Surfaced in `records()` so the UI shows the
   * failure instead of the plugin silently vanishing.
   */
  private readonly failed: Map<string, FailedPlugin> = new Map();
  /**
   * Tool / tool-group names contributed by each plugin. Drained on unload so
   * the registries don't hand out stale entries pointing at torn-down state
   * (most painful symptom: a closed sqlite handle throwing "database
   * connection is not open" on the next tool call).
   */
  private readonly contributions: Map<string, PluginContributions> = new Map();
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

    // ── Import ────────────────────────────────────────────────────────────
    // The dynamic import itself can throw (bad path, syntax error, missing
    // dep). Wrap so the dispatcher can render a structured "failed" row
    // instead of leaking a raw stack trace.
    let mod: { default?: PluginDescriptor };
    try {
      mod = (await import(specifier)) as { default?: PluginDescriptor };
    } catch (cause) {
      const err = new PluginLoadError({
        code: "import_failed",
        pluginSource: entryPath,
        message: `failed to import plugin at ${entryPath}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      });
      this.recordFailure(err, config);
      throw err;
    }
    const descriptor = mod.default;
    if (!descriptor || typeof descriptor.register !== "function") {
      const err = new PluginLoadError({
        code: "import_failed",
        pluginSource: entryPath,
        message: `plugin at ${entryPath} has no valid default export`,
      });
      this.recordFailure(err, config);
      throw err;
    }

    // ── Validate config against the plugin's schema (when present) ───────
    let effectiveConfig = config;
    if (descriptor.configSchema) {
      const parsed = (descriptor.configSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: (string | number)[]; message: string }> } } }).safeParse(config);
      if (!parsed.success) {
        const first = parsed.error?.issues[0];
        const fieldName = first?.path.length ? String(first.path[0]) : "(unknown)";
        const err = new PluginLoadError({
          code: "missing_config",
          pluginSource: entryPath,
          pluginId: descriptor.id,
          message: `plugin "${descriptor.id}" config invalid: ${first?.message ?? "validation failed"}`,
          details: { field: fieldName, issues: parsed.error?.issues ?? [] },
        });
        this.recordFailure(err, config, descriptor.id);
        throw err;
      }
      effectiveConfig = parsed.data as Record<string, unknown>;
    }

    // ── register(api) ─────────────────────────────────────────────────────
    const uiContributions: PluginUiContribution[] = [];
    const api = this.apiFor(
      effectiveConfig,
      uiContributions,
      manifest?.permissions,
      descriptor.id,
    );
    let cleanup: void | (() => void | Promise<void>);
    try {
      cleanup = await descriptor.register(api);
    } catch (cause) {
      // Partial contributions from a failed register() must not linger in
      // the global registries — otherwise reloading the plugin trips
      // duplicate-name conflicts and the agent can still resolve a tool
      // whose plugin never finished bootstrapping.
      this.evictContributions(descriptor.id);
      this.deps.unregisterHttpRoutesForPlugin?.(descriptor.id);
      this.deps.unregisterPromptFragmentsForPlugin?.(descriptor.id);
      // MissingConfigError → preserve the structured fields so the UI can
      // open a configure form pre-pointed at the offending key.
      if (cause instanceof MissingConfigError) {
        const err = new PluginLoadError({
          code: "missing_config",
          pluginSource: entryPath,
          pluginId: descriptor.id,
          message: cause.message,
          cause,
          details: {
            field: cause.field,
            ...(cause.envVar !== undefined ? { envVar: cause.envVar } : {}),
            ...(cause.hint !== undefined ? { hint: cause.hint } : {}),
          },
        });
        this.recordFailure(err, effectiveConfig, descriptor.id);
        throw err;
      }
      const err = new PluginLoadError({
        code: "register_failed",
        pluginSource: entryPath,
        pluginId: descriptor.id,
        message: `plugin "${descriptor.id}" register() threw: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      });
      this.recordFailure(err, effectiveConfig, descriptor.id);
      throw err;
    }

    const entry: LoadedPlugin = {
      descriptor,
      source: entryPath,
      ...(manifest ? { manifest } : {}),
      config: effectiveConfig,
      enabled: true,
      installedAt: new Date().toISOString(),
      uiContributions,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
    this.loaded.set(descriptor.id, entry);
    // Successful load supersedes any prior failure — drop the failed entry
    // so the dashboard stops showing a stale error banner.
    this.failed.delete(descriptor.id);
    this.failed.delete(entryPath);
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

  /**
   * Drop every tool / tool-group this plugin registered. Idempotent — safe
   * to call from both the unload path and the failed-register cleanup.
   */
  private evictContributions(id: string): void {
    const owned = this.contributions.get(id);
    if (!owned) return;
    for (const name of owned.toolNames) this.deps.toolRegistry.unregister(name);
    for (const name of owned.toolGroupNames) this.deps.toolGroups.unregister(name);
    this.contributions.delete(id);
  }

  /**
   * Stash a load failure so it shows up in `records()` with status="failed".
   * Idempotent — replaces any earlier failure under the same key.
   */
  private recordFailure(
    err: PluginLoadError,
    config: Record<string, unknown>,
    explicitId?: string,
  ): void {
    const id = explicitId ?? err.pluginId ?? err.pluginSource;
    const details: PluginErrorDetails = {
      code: err.code,
      message: err.message,
      ...(typeof err.details["field"] === "string"
        ? { field: err.details["field"] as string }
        : {}),
      ...(typeof err.details["envVar"] === "string"
        ? { envVar: err.details["envVar"] as string }
        : {}),
      ...(typeof err.details["hint"] === "string"
        ? { hint: err.details["hint"] as string }
        : {}),
    };
    const failed: FailedPlugin = {
      id,
      source: err.pluginSource,
      config,
      error: details,
      installedAt: new Date().toISOString(),
    };
    this.failed.set(id, failed);
    this.deps.logger.error(
      { id, source: err.pluginSource, code: err.code, message: err.message },
      "plugin load failed — gateway continuing",
    );
    this.deps.onPluginChanged?.(this.failedToRecord(failed));
  }

  /** Catalog / dispatch view of failed entries. */
  failedRecords(): PluginRecord[] {
    return Array.from(this.failed.values()).map((f) => this.failedToRecord(f));
  }

  /** Drop a failed entry — used after `plugins.uninstall` rolls back. */
  clearFailure(idOrSource: string): void {
    this.failed.delete(idOrSource);
  }

  private failedToRecord(f: FailedPlugin): PluginRecord {
    return {
      id: f.id,
      name: f.id,
      version: "0.0.0",
      kinds: [],
      enabled: false,
      ...(Object.keys(f.config).length > 0 ? { config: f.config } : {}),
      source: f.source,
      installedAt: f.installedAt,
      uiContributions: [],
      status: "failed",
      error: f.error,
    };
  }

  async unload(id: string): Promise<void> {
    const entry = this.loaded.get(id);
    if (!entry) return;
    // Evict tool / tool-group registrations BEFORE running the plugin's
    // cleanup. Plugin teardowns commonly close database handles or sockets
    // that the registered tools captured by reference; if a caller resolved
    // the tool between cleanup and registry eviction it would call into a
    // torn-down resource (e.g. better-sqlite3 throws "The database
    // connection is not open"). Dropping registry entries first makes the
    // tool unresolvable instead.
    this.evictContributions(id);
    if (entry.cleanup) {
      try {
        await entry.cleanup();
      } catch (err) {
        this.deps.logger.error({ err, id }, "plugin cleanup threw");
      }
    }
    this.deps.unregisterPromptFragmentsForPlugin?.(id);
    this.deps.unregisterHttpRoutesForPlugin?.(id);
    this.loaded.delete(id);
    this.deps.logger.info({ id, source: entry.source }, "plugin unloaded");
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
    this.deps.logger.info({ id, enabled }, "plugin enabled flag changed");
    this.deps.onPluginChanged?.(rec);
    return rec;
  }

  setConfig(id: string, config: Record<string, unknown>): PluginRecord | null {
    const entry = this.loaded.get(id);
    if (!entry) return null;
    entry.config = config;
    const rec = this.toRecord(entry);
    this.deps.logger.info({ id, fields: Object.keys(config) }, "plugin config updated");
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
    const loaded = Array.from(this.loaded.values()).map((e) => this.toRecord(e));
    // Failed records are appended so the UI can render an error banner per
    // row. Dedup by id + source: if the same source somehow loaded *and*
    // appears in failed (shouldn't happen, but be safe), prefer loaded.
    const loadedKeys = new Set<string>();
    for (const r of loaded) {
      loadedKeys.add(r.id);
      loadedKeys.add(r.source);
    }
    const failed = Array.from(this.failed.values())
      .filter((f) => !loadedKeys.has(f.id) && !loadedKeys.has(f.source))
      .map((f) => this.failedToRecord(f));
    return [...loaded, ...failed];
  }

  recordFor(id: string): PluginRecord | null {
    const entry = this.loaded.get(id);
    if (entry) return this.toRecord(entry);
    const fail = this.failed.get(id);
    return fail ? this.failedToRecord(fail) : null;
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
      status: entry.enabled ? "loaded" : "disabled",
    };
  }

  private apiFor(
    config: Record<string, unknown>,
    uiBuf: PluginUiContribution[],
    permissions?: PluginPermission[],
    pluginId?: string,
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
    const trackContribution = (kind: "tool" | "toolGroup", name: string): void => {
      if (!pluginId) return;
      let owned = this.contributions.get(pluginId);
      if (!owned) {
        owned = { toolNames: new Set(), toolGroupNames: new Set() };
        this.contributions.set(pluginId, owned);
      }
      (kind === "tool" ? owned.toolNames : owned.toolGroupNames).add(name);
    };
    const getRuntime = this.deps.runtime;
    return {
      tools: {
        register: (tool: AnyTool) => {
          if (!allow("tools")) denied("tools");
          this.deps.toolRegistry.register(tool);
          trackContribution("tool", tool.name);
        },
      },
      toolGroups: {
        register: (group: ToolGroup) => {
          if (!allow("toolGroups")) denied("toolGroups");
          this.deps.toolGroups.register(group);
          trackContribution("toolGroup", group.name);
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
        register: (
          kind: string,
          handler: PluginDeliveryHandler,
          meta?: PluginDeliveryMeta,
        ) => {
          if (!allow("delivery")) denied("delivery");
          this.deps.registerDelivery(kind, handler, meta);
        },
      },
      promptFragments: {
        register: (fragment: PluginPromptFragment) => {
          // No declared permission gate — fragments are pure metadata.
          if (!this.deps.registerPromptFragment) return;
          this.deps.registerPromptFragment(pluginId ?? "unknown", fragment);
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
          this.deps.registerHttpRoute(method, path, handler, pluginId ?? "unknown");
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
      get runtime(): PluginRuntimeInfo {
        return getRuntime();
      },
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
    } catch (err) {
      moduleLog.warn({ err, path: c }, "plugin manifest exists but failed to parse");
      return null;
    }
  }
  return null;
}
