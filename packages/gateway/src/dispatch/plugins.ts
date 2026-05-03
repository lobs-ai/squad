import { randomBytes } from "node:crypto";
import type { Dispatcher } from "./index.js";
import type { PluginHost } from "../plugins/host.js";
import type { ConfigBackend } from "@squad/tools";
import {
  ErrorCode,
  ProtocolError,
  type PluginCatalogEntry,
  type PluginSecretField,
} from "@squad/protocol";
import {
  describeConfigSchema,
  readSchemaMeta,
  PluginLoadError,
  type PluginConfigField,
} from "@squad/plugin-sdk";
import {
  PREINSTALLED_PLUGINS,
  findCatalogEntry,
  type CatalogEntry,
} from "../plugins/catalog.js";
import { logger as rootLogger } from "../logger.js";
import type { SecretStore } from "../secrets/store.js";
import type { PluginSetupSessionFactory } from "../plugins/setup-session.js";

const log = rootLogger.child({ component: "dispatch.plugins" });

export interface PluginDispatchDeps {
  host: PluginHost;
  /**
   * Optional config backend so install/uninstall can persist the change to
   * `config.plugins[]`. Absent in tests; the methods then return an error
   * rather than silently failing — surfaces a real misconfiguration.
   */
  configBackend?: ConfigBackend;
  /**
   * Optional secret store. When present, `plugins.install` writes any
   * `secrets` map values to the store and `plugins.uninstall` removes
   * them. When absent (tests), install rejects calls that try to set
   * secrets so a missing store doesn't silently lose user input.
   */
  secretStore?: SecretStore;
  /**
   * Optional session factory used by `plugins.start_setup_chat`. When
   * absent, the method throws — the gateway always supplies one in
   * production but tests can opt out.
   */
  setupSessionFactory?: PluginSetupSessionFactory;
}

type PluginEntry = string | { path: string; config?: Record<string, unknown> };

interface AuthTokenEntry {
  label: string;
  key?: string;
  key_env?: string;
  scopes?: string[];
}

/**
 * Mutate `config.plugins[]` in-place via the backend. Reads the current
 * array, applies `mutate`, and writes the result back through `setValue`
 * which re-validates the whole config before persisting.
 */
async function mutatePluginsConfig(
  backend: ConfigBackend,
  mutate: (list: PluginEntry[]) => PluginEntry[],
): Promise<void> {
  const raw = (await backend.getValue("plugins")) ?? [];
  const list = Array.isArray(raw) ? (raw as PluginEntry[]) : [];
  const next = mutate(list);
  await backend.setValue("plugins", next);
}

/**
 * Mutate `config.auth.tokens[]`. Independent of `mutatePluginsConfig` so
 * install/uninstall can write both atomically (well, near-atomically — two
 * separate writes, but both go through `setValue` which validates the
 * whole object each time).
 */
async function mutateAuthTokens(
  backend: ConfigBackend,
  mutate: (tokens: AuthTokenEntry[]) => AuthTokenEntry[],
): Promise<void> {
  const raw = (await backend.getValue("auth.tokens")) ?? [];
  const list = Array.isArray(raw) ? (raw as AuthTokenEntry[]) : [];
  const next = mutate(list);
  await backend.setValue("auth.tokens", next);
}

function entryPath(entry: PluginEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

function entryConfig(entry: PluginEntry): Record<string, unknown> {
  return typeof entry === "string" ? {} : (entry.config ?? {});
}

/**
 * Generate a 32-byte hex token. Used for `secret + autoGenerate` fields and
 * for `needsAuthToken` entries. Cryptographically random — these are real
 * auth secrets, not just unique ids.
 */
function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Apply default values + auto-generate secrets for any field the catalog
 * schema marked as such. Mutates a copy and returns it.
 */
function applySchemaDefaults(
  entry: CatalogEntry,
  userConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(entry.defaultConfig ?? {}),
    ...userConfig,
  };
  if (!entry.configSchema) return merged;
  const meta = readSchemaMeta(entry.configSchema);
  for (const [field, m] of Object.entries(meta)) {
    if (m.autoGenerate && (merged[field] === undefined || merged[field] === "")) {
      merged[field] = generateSecret();
    }
  }
  return merged;
}

/**
 * Build a redacted copy of `config` with secret fields replaced by a
 * placeholder. Used by `plugins.describe` so the dashboard knows the field
 * is set without leaking the value.
 */
function redactSecrets(
  entry: CatalogEntry,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!entry.configSchema) return config;
  const meta = readSchemaMeta(entry.configSchema);
  const out: Record<string, unknown> = { ...config };
  for (const [field, m] of Object.entries(meta)) {
    if (m.secret && typeof out[field] === "string" && (out[field] as string).length > 0) {
      out[field] = "•••";
    }
  }
  return out;
}

/**
 * Throw a `ProtocolError` carrying the structured plugin load error in its
 * `data` field. The wire layer round-trips `data` to the client untouched,
 * so the dashboard can switch on `error.data.code` ("missing_config" etc.)
 * to render a configure form instead of a generic toast.
 */
function throwLoadError(err: PluginLoadError): never {
  const data: Record<string, unknown> = {
    code: err.code,
  };
  if (err.pluginId !== undefined) data["pluginId"] = err.pluginId;
  if (typeof err.details["field"] === "string") data["field"] = err.details["field"];
  if (typeof err.details["envVar"] === "string") data["envVar"] = err.details["envVar"];
  if (typeof err.details["hint"] === "string") data["hint"] = err.details["hint"];
  throw new ProtocolError(
    err.code === "missing_config" ? ErrorCode.invalid_params : ErrorCode.internal_error,
    err.message,
    data,
  );
}

export function registerPluginMethods(
  dispatcher: Dispatcher,
  deps: PluginDispatchDeps | PluginHost,
): void {
  // Back-compat: callers used to hand us a bare PluginHost. Detect that and
  // wrap so existing tests / call sites keep working.
  const { host, configBackend, secretStore, setupSessionFactory }: PluginDispatchDeps =
    "load" in (deps as object)
      ? { host: deps as PluginHost }
      : (deps as PluginDispatchDeps);

  dispatcher.register("plugins.list", async () => ({ plugins: host.records() }));

  dispatcher.register("plugins.enable", async (params) => {
    const r = host.setEnabled(params.id, true);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.disable", async (params) => {
    const r = host.setEnabled(params.id, false);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.reload", async (params) => {
    const r = await host.reload(params.id);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.configure", async (params) => {
    const r = host.setConfig(params.id, params.config);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.catalog", async () => {
    // Match loaded plugins by their `source` rather than descriptor id —
    // some plugins (eg. channel-discord) use a short id that doesn't equal
    // the catalog id, so an id-only check would falsely report "not loaded".
    const loadedSources = new Set(host.records().map((p) => p.source));
    const installedSources: Set<string> = new Set();
    if (configBackend) {
      const raw = (await configBackend.getValue("plugins")) ?? [];
      if (Array.isArray(raw)) {
        for (const e of raw) {
          installedSources.add(entryPath(e as PluginEntry));
        }
      }
    } else {
      for (const s of loadedSources) installedSources.add(s);
    }
    const entries: PluginCatalogEntry[] = PREINSTALLED_PLUGINS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kinds: [...p.kinds],
      source: p.source,
      requires: [...(p.requires ?? [])],
      installed: installedSources.has(p.source),
      loaded: loadedSources.has(p.source),
    }));
    return { entries };
  });

  /**
   * Returns the configure-form description for a catalog entry: the
   * generated field list, defaultConfig, currentConfig (with secrets
   * redacted), and whether install will create an auth.tokens entry.
   *
   * The form generator on the dashboard / CLI consumes this — no client
   * needs to import Zod or the catalog itself.
   */
  dispatcher.register("plugins.describe", async (params) => {
    const entry = findCatalogEntry(params.id);
    if (!entry) throw new Error(`unknown preinstalled plugin: ${params.id}`);
    const fields: PluginConfigField[] = entry.configSchema
      ? describeConfigSchema(entry.configSchema)
      : [];
    let currentConfig: Record<string, unknown> | undefined;
    if (configBackend) {
      const raw = (await configBackend.getValue("plugins")) ?? [];
      if (Array.isArray(raw)) {
        const found = (raw as PluginEntry[]).find(
          (p) => entryPath(p) === entry.source,
        );
        if (found) currentConfig = redactSecrets(entry, entryConfig(found));
      }
    }
    // External secrets (env-var-backed). The describe payload reports
    // whether the gateway already has a value stored — never the value
    // itself. The configure form uses `set` to render "(set, leave blank
    // to keep)" placeholders.
    const secrets: PluginSecretField[] = (entry.secrets ?? []).map((s) => {
      const isSet = secretStore ? secretStore.has(s.envVar) : false;
      const out: PluginSecretField = {
        envVar: s.envVar,
        set: isSet,
      };
      if (s.label !== undefined) out.label = s.label;
      if (s.required !== undefined) out.required = s.required;
      if (s.hint !== undefined) out.hint = s.hint;
      return out;
    });
    const result: {
      id: string;
      name: string;
      description: string;
      fields: PluginConfigField[];
      defaultConfig: Record<string, unknown>;
      currentConfig?: Record<string, unknown>;
      needsAuthToken: boolean;
      secrets: PluginSecretField[];
      setupPlaybook?: string;
    } = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      fields,
      defaultConfig: entry.defaultConfig ?? {},
      needsAuthToken: Boolean(entry.needsAuthToken),
      secrets,
    };
    if (currentConfig !== undefined) result.currentConfig = currentConfig;
    if (entry.setupPlaybook !== undefined) result.setupPlaybook = entry.setupPlaybook;
    return result;
  });

  /**
   * Install flow:
   *  1. Build the effective config: catalog defaults ← user input ← any
   *     auto-generated secrets from the schema.
   *  2. If the catalog declares `needsAuthToken`, generate the token,
   *     append a matching `auth.tokens[]` entry, and store the literal
   *     under the schema key.
   *  3. Persist `config.plugins[]`.
   *  4. Try to load. On failure, roll back both writes so retrying with
   *     fixed input doesn't pile up duplicate token entries / orphaned
   *     plugin entries.
   *
   * Errors from the load step are returned as structured payloads (not
   * thrown) so the dashboard can render row-scoped feedback. Other errors
   * (unknown plugin id, no backend) still throw — those are caller bugs.
   */
  dispatcher.register("plugins.install", async (params) => {
    const entry = findCatalogEntry(params.id);
    if (!entry) throw new Error(`unknown preinstalled plugin: ${params.id}`);
    if (!configBackend) {
      throw new Error(
        "plugins.install requires a writable config backend; gateway is running without one",
      );
    }
    const requested = params.config ?? {};
    const merged = applySchemaDefaults(entry, requested);

    // External secrets: write to the secret store BEFORE persisting config
    // and BEFORE attempting the load, since plugins read them via
    // `process.env`. Track which keys we wrote/changed so we can roll back
    // cleanly when the load fails.
    const requestedSecrets = params.secrets ?? {};
    const secretRollback: Array<{ envVar: string; prior: string | undefined }> = [];
    if (Object.keys(requestedSecrets).length > 0) {
      if (!secretStore) {
        throw new ProtocolError(
          ErrorCode.invalid_params,
          "plugins.install: secrets supplied but no secret store is configured on this gateway",
        );
      }
      const declared = new Set((entry.secrets ?? []).map((s) => s.envVar));
      for (const [envVar, value] of Object.entries(requestedSecrets)) {
        if (!declared.has(envVar)) {
          throw new ProtocolError(
            ErrorCode.invalid_params,
            `plugins.install: secret "${envVar}" is not declared by ${entry.id}`,
          );
        }
        if (typeof value !== "string" || value.length === 0) continue;
        secretRollback.push({ envVar, prior: secretStore.get(envVar) });
        secretStore.set(envVar, value);
      }
    }
    // Pre-flight: any required secret with no stored value (and none
    // supplied this call) → tell the user up front instead of letting the
    // plugin throw a cryptic missing-token error.
    //
    // "Available" means any of:
    //   1. supplied in this call's `secrets` map (we'll write it next),
    //   2. already in our secret store (set earlier),
    //   3. already in `process.env` (operator exported it via shell /
    //      docker / .env at boot — the plugin will read it fine without
    //      our store knowing about it).
    if (entry.secrets && secretStore) {
      const missing = entry.secrets.filter((s) => {
        if (!s.required) return false;
        if (s.envVar in requestedSecrets && (requestedSecrets[s.envVar] ?? "").length > 0)
          return false;
        if (secretStore.has(s.envVar)) return false;
        const liveEnv = process.env[s.envVar];
        if (typeof liveEnv === "string" && liveEnv.length > 0) return false;
        return true;
      });
      if (missing.length > 0) {
        // Roll back any partial secret writes from this call before erroring.
        for (const r of secretRollback) {
          if (r.prior === undefined) secretStore.unset(r.envVar);
          else secretStore.set(r.envVar, r.prior);
        }
        const first = missing[0]!;
        throw new ProtocolError(
          ErrorCode.invalid_params,
          `Required secret "${first.envVar}" is not set. Provide it under the "secrets" field of plugins.install.`,
          {
            code: "missing_secret",
            envVar: first.envVar,
            field: first.envVar,
            hint: first.hint,
          },
        );
      }
    }

    // Auth-token path: when the catalog declares this plugin needs to talk
    // back to the gateway, materialize the token here and stamp it into both
    // sides (auth.tokens and the plugin's config).
    let generatedAuthToken: { label: string; key: string } | undefined;
    if (entry.needsAuthToken) {
      const key = entry.needsAuthToken.tokenConfigKey;
      const existing = merged[key];
      const tokenValue =
        typeof existing === "string" && existing.length > 0
          ? existing
          : generateSecret();
      merged[key] = tokenValue;
      const label = entry.needsAuthToken.label ?? entry.id;
      generatedAuthToken = { label, key: tokenValue };
      await mutateAuthTokens(configBackend, (tokens) => {
        // Replace any earlier entry with the same label so reinstalls don't
        // accumulate stale tokens.
        const without = tokens.filter((t) => t.label !== label);
        return [
          ...without,
          {
            label,
            key: tokenValue,
            scopes: entry.needsAuthToken!.scopes ?? ["*"],
          },
        ];
      });
    }

    // Snapshot prior state so we can roll back on failure.
    const priorPluginsRaw = (await configBackend.getValue("plugins")) ?? [];
    const priorPlugins: PluginEntry[] = Array.isArray(priorPluginsRaw)
      ? (priorPluginsRaw as PluginEntry[])
      : [];

    await mutatePluginsConfig(configBackend, (list) => {
      const without = list.filter((p) => entryPath(p) !== entry.source);
      const newEntry: PluginEntry =
        Object.keys(merged).length > 0
          ? { path: entry.source, config: merged }
          : entry.source;
      return [...without, newEntry];
    });

    const findLoadedBySource = (): string | undefined =>
      host.records().find((r) => r.source === entry.source && r.status === "loaded")?.id;

    try {
      const existingId = findLoadedBySource();
      if (existingId) {
        const record = await host.reload(existingId);
        if (!record) {
          throw new Error(`plugin ${entry.id} reload returned no record`);
        }
        log.info({ pluginId: entry.id, source: entry.source }, "plugin reloaded after install");
        return { plugin: record };
      }
      await host.load(entry.source, merged);
      const id = findLoadedBySource();
      const record = id ? host.recordFor(id) : null;
      if (!record) {
        throw new Error(`plugin ${entry.id} loaded but produced no record`);
      }
      log.info({ pluginId: entry.id, source: entry.source }, "plugin installed");
      return { plugin: record };
    } catch (err) {
      log.error({ err, pluginId: entry.id, source: entry.source }, "plugin install failed");
      // Roll back config writes so the user can retry with fixed input
      // without leaving stale entries behind. Don't roll back the auth
      // token if the failure was register_failed — a token they can re-use
      // is usually less annoying than re-generating one each retry.
      try {
        await configBackend.setValue("plugins", priorPlugins);
      } catch (rollbackErr) {
        log.warn(
          { err: rollbackErr, pluginId: entry.id },
          "plugins.install rollback (config.plugins) failed",
        );
      }
      if (
        generatedAuthToken &&
        err instanceof PluginLoadError &&
        err.code !== "register_failed"
      ) {
        try {
          await mutateAuthTokens(configBackend, (tokens) =>
            tokens.filter((t) => t.label !== generatedAuthToken!.label),
          );
        } catch (rollbackErr) {
          log.warn(
            { err: rollbackErr, pluginId: entry.id, label: generatedAuthToken.label },
            "plugins.install rollback (auth.tokens) failed",
          );
        }
      }
      // Secret rollback: only when the failure is something the user can
      // fix by re-supplying the secret (i.e. NOT register_failed, where
      // the plugin's own logic threw — keeping the secret means retrying
      // is one fewer thing to type).
      if (
        secretRollback.length > 0 &&
        secretStore &&
        err instanceof PluginLoadError &&
        err.code !== "register_failed"
      ) {
        for (const r of secretRollback) {
          try {
            if (r.prior === undefined) secretStore.unset(r.envVar);
            else secretStore.set(r.envVar, r.prior);
          } catch (rollbackErr) {
            log.warn(
              { err: rollbackErr, pluginId: entry.id, envVar: r.envVar },
              "plugins.install rollback (secret) failed",
            );
          }
        }
      }
      if (err instanceof PluginLoadError) {
        throwLoadError(err);
      }
      throw err;
    }
  });

  dispatcher.register("plugins.uninstall", async (params) => {
    const entry = findCatalogEntry(params.id);
    if (!entry) throw new Error(`unknown preinstalled plugin: ${params.id}`);
    if (!configBackend) {
      throw new Error(
        "plugins.uninstall requires a writable config backend; gateway is running without one",
      );
    }
    await mutatePluginsConfig(configBackend, (list) =>
      list.filter((p) => entryPath(p) !== entry.source),
    );
    if (entry.needsAuthToken) {
      const label = entry.needsAuthToken.label ?? entry.id;
      await mutateAuthTokens(configBackend, (tokens) =>
        tokens.filter((t) => t.label !== label),
      );
    }
    if (entry.secrets && secretStore) {
      for (const s of entry.secrets) {
        try {
          secretStore.unset(s.envVar);
        } catch (err) {
          log.warn(
            { err, pluginId: entry.id, envVar: s.envVar },
            "plugins.uninstall: secret unset failed",
          );
        }
      }
    }
    const loaded = host.records().find((r) => r.source === entry.source);
    if (loaded) {
      try {
        await host.unload(loaded.id);
      } catch (unloadErr) {
        log.warn(
          { err: unloadErr, pluginId: entry.id, loadedId: loaded.id },
          "plugins.uninstall: unload failed (config already cleared)",
        );
      }
      host.clearFailure(loaded.id);
    }
    // Drop any failed entry that lingers under the source path.
    host.clearFailure(entry.source);
    log.info({ pluginId: entry.id, source: entry.source }, "plugin uninstalled");
    return { id: entry.id };
  });

  /**
   * Spin up a fresh chat session devoted to walking the user through this
   * plugin's setup. Embeds the describe payload + setupPlaybook into the
   * first message so the agent has the full picture without round-tripping.
   *
   * Same install path is reachable from the new session via the
   * `plugin_install` tool — there's nothing setup-chat-specific about how
   * the install actually happens.
   */
  dispatcher.register("plugins.start_setup_chat", async (params) => {
    const entry = findCatalogEntry(params.id);
    if (!entry) throw new Error(`unknown preinstalled plugin: ${params.id}`);
    if (!setupSessionFactory) {
      throw new Error(
        "plugins.start_setup_chat is unavailable: gateway has no setup session factory",
      );
    }
    // Re-run describe so the seeded payload always reflects the current
    // gateway state (e.g. which secrets are already set).
    const fields: PluginConfigField[] = entry.configSchema
      ? describeConfigSchema(entry.configSchema)
      : [];
    let currentConfig: Record<string, unknown> | undefined;
    if (configBackend) {
      const raw = (await configBackend.getValue("plugins")) ?? [];
      if (Array.isArray(raw)) {
        const found = (raw as PluginEntry[]).find(
          (p) => entryPath(p) === entry.source,
        );
        if (found) currentConfig = redactSecrets(entry, entryConfig(found));
      }
    }
    const secrets: PluginSecretField[] = (entry.secrets ?? []).map((s) => {
      const isSet = secretStore ? secretStore.has(s.envVar) : false;
      const out: PluginSecretField = { envVar: s.envVar, set: isSet };
      if (s.label !== undefined) out.label = s.label;
      if (s.required !== undefined) out.required = s.required;
      if (s.hint !== undefined) out.hint = s.hint;
      return out;
    });
    const describePayload: Record<string, unknown> = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      fields,
      defaultConfig: entry.defaultConfig ?? {},
      needsAuthToken: Boolean(entry.needsAuthToken),
      secrets,
      ...(currentConfig !== undefined ? { currentConfig } : {}),
      ...(entry.setupPlaybook !== undefined ? { setupPlaybook: entry.setupPlaybook } : {}),
    };
    const { sessionId, seedMessage } = setupSessionFactory.create({
      entry,
      describePayload,
    });
    log.info({ pluginId: entry.id, sessionId }, "plugin setup chat started");
    return { sessionId, seedMessage };
  });
}
