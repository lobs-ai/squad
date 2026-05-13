import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  /**
   * Resolve a bare specifier (e.g. `"@squad/plugin-google-auth"`) to an
   * absolute file path. Used by `loadMany` to discover an installed plugin's
   * manifest before importing. Defaults to Node's resolver scoped to this
   * file; tests stub it to point at fixture plugins.
   */
  resolveModule?: (specifier: string) => string;
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
    const manifest = absolute ? loadManifestNear(absolute)?.manifest ?? null : null;

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
   * Load a batch of plugin entries in dependency order.
   *
   * Behavior:
   *  - Reads each entry's manifest up front (handles bare specifiers too).
   *  - Auto-loads any `requires` plugin that's installed but not listed in
   *    `entries`. Plugins added this way receive an empty config.
   *  - Topologically sorts by `requires` so dependencies always load first.
   *  - Detects cycles: each plugin in a cycle is recorded as a failure with
   *    a message naming the cycle (`A → B → A`). The rest of the graph still
   *    loads.
   *  - Unresolvable deps (declared in `requires`, not in the batch, not
   *    installed) are not auto-added; the existing pre-flight check in
   *    `load()` then fails the dependent plugin with its own clear error.
   *
   * Returns the same `{ source, error }` shape the gateway boot loop used to
   * collect into `pluginLoadFailures`.
   */
  async loadMany(
    entries: ReadonlyArray<string | { path: string; config?: Record<string, unknown> }>,
  ): Promise<Array<{ source: string; error: string }>> {
    const failures: Array<{ source: string; error: string }> = [];

    const plan: PluginPlanEntry[] = entries.map((e) => {
      const path = typeof e === "string" ? e : e.path;
      const config: Record<string, unknown> =
        typeof e === "string" ? {} : ((e.config ?? {}) as Record<string, unknown>);
      const found = readManifestForEntry(path);
      return { path, config, manifest: found?.manifest ?? null, autoLoaded: false };
    });

    // Index by manifest id so we can detect when a `requires` is already in
    // the batch versus needs auto-discovery.
    const byManifestId = new Map<string, PluginPlanEntry>();
    for (const p of plan) if (p.manifest) byManifestId.set(p.manifest.id, p);

    // Auto-discover installed-but-unlisted deps. Walk a queue so we pick up
    // transitive auto-loads (auth → drive → some-shared-thing).
    const resolveModule =
      this.deps.resolveModule ?? createRequire(import.meta.url).resolve.bind(createRequire(import.meta.url));
    const queue: PluginPlanEntry[] = plan.filter((p) => p.manifest !== null);
    while (queue.length > 0) {
      const p = queue.shift()!;
      if (!p.manifest) continue;
      for (const req of p.manifest.requires) {
        const reqId = parseRequiresId(req);
        if (byManifestId.has(reqId)) continue;
        const resolved = tryResolvePluginById(reqId, resolveModule);
        if (!resolved) continue; // existing load()-time check will surface this
        const autoEntry: PluginPlanEntry = {
          path: resolved.entry,
          config: {},
          manifest: resolved.manifest,
          autoLoaded: true,
        };
        plan.push(autoEntry);
        byManifestId.set(resolved.manifest.id, autoEntry);
        queue.push(autoEntry);
        this.deps.logger.info(
          { id: resolved.manifest.id, requiredBy: p.manifest.id },
          "plugin auto-loaded to satisfy requires",
        );
      }
    }

    // Build the keyed plan used by the sort. Entries without a manifest get a
    // synthetic id so they still appear in `order`; they have no declared deps
    // and so always sort cleanly to the front.
    const idToEntry = new Map<string, PluginPlanEntry>();
    const idOf = (p: PluginPlanEntry, i: number): string =>
      p.manifest?.id ?? `__nomanifest:${i}:${p.path}`;
    plan.forEach((p, i) => idToEntry.set(idOf(p, i), p));

    const { order, unresolved, cyclePath } = topoSortPlugins(idToEntry);

    // Fail every plugin that couldn't be scheduled. The unresolved set
    // includes both members of a cycle and anything transitively pointing at
    // one — they all share the same failure mode (their deps will never
    // resolve), so flag them all.
    const unresolvedSet = new Set(unresolved);
    for (const id of unresolved) {
      const p = idToEntry.get(id);
      if (!p) continue;
      const cycle = cyclePath.get(id);
      const message = cycle
        ? `plugin "${p.manifest?.id ?? p.path}" is part of a requires cycle: ${cycle.join(" → ")}`
        : `plugin "${p.manifest?.id ?? p.path}" cannot load: depends on a plugin in a requires cycle`;
      const err = new PluginLoadError({
        code: "register_failed",
        pluginSource: p.path,
        ...(p.manifest ? { pluginId: p.manifest.id } : {}),
        message,
      });
      this.recordFailure(err, p.config, p.manifest?.id);
      failures.push({ source: p.path, error: message });
    }

    for (const id of order) {
      if (unresolvedSet.has(id)) continue; // belt + suspenders; topo skipped these
      const p = idToEntry.get(id);
      if (!p) continue;
      try {
        await this.load(p.path, p.config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err, pluginPath: p.path }, "failed to load plugin");
        failures.push({ source: p.path, error: msg });
      }
    }

    return failures;
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
function loadManifestNear(entryAbs: string): { manifest: PluginManifest; dir: string } | null {
  const candidates = [
    join(dirname(entryAbs), "squad.plugin.json"),
    join(dirname(dirname(entryAbs)), "squad.plugin.json"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const raw = JSON.parse(readFileSync(c, "utf8"));
      return { manifest: parsePluginManifest(raw), dir: dirname(c) };
    } catch (err) {
      moduleLog.warn({ err, path: c }, "plugin manifest exists but failed to parse");
      return null;
    }
  }
  return null;
}

/**
 * Strip the version range off a `requires` entry. `"@squad/foo@^1"` → `"@squad/foo"`,
 * `"@squad/foo"` → `"@squad/foo"`. Matches the parsing in `satisfiesRequires`.
 */
function parseRequiresId(req: string): string {
  const at = req.lastIndexOf("@");
  if (at <= 0) return req;
  return req.slice(0, at);
}

/**
 * Resolve a plugin entry path to its manifest. Handles absolute paths, relative
 * paths, and bare specifiers — for bare specifiers, uses Node's module resolver
 * to find the package on disk so we can read the manifest before importing.
 * Returns null when no manifest is found (back-compat for unannotated plugins).
 */
function readManifestForEntry(entryPath: string): { manifest: PluginManifest; dir: string } | null {
  const looksLikePath =
    isAbsolute(entryPath) ||
    entryPath.startsWith("./") ||
    entryPath.startsWith("../");
  let absolute: string | null = null;
  if (looksLikePath) {
    absolute = isAbsolute(entryPath) ? entryPath : resolvePath(process.cwd(), entryPath);
  } else {
    try {
      const require_ = createRequire(import.meta.url);
      absolute = require_.resolve(entryPath);
    } catch {
      return null;
    }
  }
  return loadManifestNear(absolute);
}

/**
 * Locate an installed plugin package by its declared id (e.g.
 * `"@squad/plugin-google-auth"`) and compute the entry path the host should
 * import. Used to auto-load a `requires` entry that's installed but not
 * explicitly listed in `config.plugins`. Returns null when the package can't
 * be resolved or has no manifest.
 */
function tryResolvePluginById(
  id: string,
  resolver: (specifier: string) => string,
): { entry: string; manifest: PluginManifest } | null {
  let resolved: string;
  try {
    resolved = resolver(id);
  } catch {
    return null;
  }
  const found = loadManifestNear(resolved);
  if (!found) return null;
  if (found.manifest.id !== id) return null;
  return { entry: join(found.dir, found.manifest.entry), manifest: found.manifest };
}

interface PluginPlanEntry {
  path: string;
  config: Record<string, unknown>;
  manifest: PluginManifest | null;
  autoLoaded: boolean;
}

/**
 * Topologically sort plugin entries by their `requires` declarations.
 * Returns `order` (ids in load order) plus `unresolved` (ids that couldn't be
 * scheduled because they sit on a dependency cycle). Plugins without a
 * manifest have no declared deps, so they always sort cleanly.
 */
function topoSortPlugins(
  byId: Map<string, PluginPlanEntry>,
): { order: string[]; unresolved: string[]; cyclePath: Map<string, string[]> } {
  // For each id, the set of dep-ids that are ALSO in `byId` (out-of-graph deps
  // get handled by the existing validation in load()).
  const deps = new Map<string, Set<string>>();
  for (const [id, entry] of byId) {
    const set = new Set<string>();
    if (entry.manifest) {
      for (const req of entry.manifest.requires) {
        const reqId = parseRequiresId(req);
        if (byId.has(reqId)) set.add(reqId);
      }
    }
    deps.set(id, set);
  }

  // Kahn's algorithm: nodes with no remaining deps go first.
  const order: string[] = [];
  const remaining = new Set(byId.keys());
  const remainingDeps = new Map<string, Set<string>>();
  for (const [id, set] of deps) remainingDeps.set(id, new Set(set));
  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if (remainingDeps.get(id)!.size === 0) ready.push(id);
    }
    if (ready.length === 0) break; // remaining nodes form / depend on a cycle
    // Sort by original insertion order so the load sequence is stable.
    ready.sort((a, b) =>
      Array.from(byId.keys()).indexOf(a) - Array.from(byId.keys()).indexOf(b),
    );
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const [, set] of remainingDeps) set.delete(id);
    }
  }

  // For each unresolved id, find a concrete cycle path so the error message
  // names the offending plugins instead of a generic "cycle detected".
  const cyclePath = new Map<string, string[]>();
  for (const id of remaining) {
    const path = findCycleFrom(id, deps);
    if (path) cyclePath.set(id, path);
  }

  return { order, unresolved: Array.from(remaining), cyclePath };
}

/**
 * DFS that returns a back-edge cycle reachable from `start`, or null if none.
 * Uses tri-color marking: WHITE = unvisited, GRAY = on the active stack, BLACK
 * = fully explored. A GRAY-hit while traversing is the cycle.
 */
function findCycleFrom(start: string, deps: Map<string, Set<string>>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    for (const d of deps.get(node) ?? []) {
      const c = color.get(d) ?? WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(d);
        return stack.slice(i).concat(d);
      }
      if (c === WHITE) {
        const found = dfs(d);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }
  return dfs(start);
}
