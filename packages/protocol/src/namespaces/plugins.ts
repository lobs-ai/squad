import { z } from "zod";

export const pluginKindSchema = z.enum([
  "tool",
  "provider",
  "channel",
  "skill",
  "routine",
  "subagent",
]);
export type PluginKind = z.infer<typeof pluginKindSchema>;

// ── UI contributions ─────────────────────────────────────────────────────
//
// Plugins can register UI affordances that the dashboard surfaces in
// well-known slots. The contract is intentionally narrow: the gateway only
// stores *that* a plugin claimed a slot (and a label/icon). Iframe-isolated
// plugin UI (the actual render code) lives in a future phase.

export const pluginUiSlotSchema = z.enum([
  "navTab",
  "overviewWidget",
  "sessionPanel",
  "toolRenderer",
  "quickAction",
]);
export type PluginUiSlot = z.infer<typeof pluginUiSlotSchema>;

export const pluginUiContributionSchema = z.object({
  slot: pluginUiSlotSchema,
  /** Stable id, scoped within the plugin (e.g. "queue-tab"). */
  id: z.string(),
  label: z.string(),
  /** Icon name from the dashboard's icon set; the dashboard substitutes a
   *  default if it doesn't recognize the value. */
  icon: z.string().optional(),
  /**
   * Hint about what the contribution acts on. e.g.:
   *   - navTab          → route slug
   *   - toolRenderer    → tool name to take over
   *   - quickAction     → command-palette action id
   */
  target: z.string().optional(),
});
export type PluginUiContribution = z.infer<typeof pluginUiContributionSchema>;

/**
 * Lifecycle state of a plugin entry. `loaded` means `register(api)` returned
 * cleanly. `failed` means we tried and the plugin threw — the gateway keeps
 * running and the dashboard surfaces the error. `disabled` is reserved for
 * the metadata flag (the plugin is loaded, the user just toggled it off).
 */
export const pluginStatusSchema = z.enum(["loaded", "failed", "disabled"]);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

/**
 * Error attached to a `failed` PluginRecord. `code` is the same vocabulary
 * the SDK's `PluginLoadError` uses, so the dashboard can switch on it
 * (e.g. render a configure form for `missing_config`).
 */
export const pluginErrorSchema = z.object({
  code: z.enum(["missing_config", "import_failed", "register_failed"]),
  message: z.string(),
  /** Field name when `code === "missing_config"`. */
  field: z.string().optional(),
  /** Env var hint, when applicable. */
  envVar: z.string().optional(),
  hint: z.string().optional(),
});
export type PluginErrorDetails = z.infer<typeof pluginErrorSchema>;

export const pluginRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  kinds: z.array(pluginKindSchema),
  enabled: z.boolean(),
  config: z.record(z.unknown()).optional(),
  source: z.string(), // path or npm spec
  installedAt: z.string(),
  /** UI slots the plugin claimed during register(api). Present even when
   *  empty so dashboards don't have to handle undefined. */
  uiContributions: z.array(pluginUiContributionSchema).default([]),
  /**
   * Lifecycle state. Defaults to "loaded" so existing serialized records
   * stay valid when this field is absent. "failed" carries `error`.
   */
  status: pluginStatusSchema.default("loaded"),
  /** Populated when `status === "failed"`. */
  error: pluginErrorSchema.optional(),
});
export type PluginRecord = z.infer<typeof pluginRecordSchema>;

export const pluginsListParams = z.object({}).optional();
export const pluginsListResult = z.object({ plugins: z.array(pluginRecordSchema) });

export const pluginsEnableParams = z.object({ id: z.string() });
export const pluginsEnableResult = z.object({ plugin: pluginRecordSchema });

export const pluginsDisableParams = z.object({ id: z.string() });
export const pluginsDisableResult = z.object({ plugin: pluginRecordSchema });

export const pluginsReloadParams = z.object({ id: z.string() });
export const pluginsReloadResult = z.object({ plugin: pluginRecordSchema });

export const pluginsConfigureParams = z.object({
  id: z.string(),
  config: z.record(z.unknown()),
});
export const pluginsConfigureResult = z.object({ plugin: pluginRecordSchema });

/**
 * One row in the preinstalled-plugin catalog. `installed` reflects whether
 * the gateway currently lists the plugin in `config.plugins[]`; `loaded`
 * reflects whether the plugin host has it imported and registered. They
 * disagree briefly while a load is in flight or after a load fails.
 */
export const pluginCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kinds: z.array(pluginKindSchema),
  source: z.string(),
  requires: z.array(z.string()).default([]),
  installed: z.boolean(),
  loaded: z.boolean(),
});
export type PluginCatalogEntry = z.infer<typeof pluginCatalogEntrySchema>;

export const pluginsCatalogParams = z.object({}).optional();
export const pluginsCatalogResult = z.object({
  entries: z.array(pluginCatalogEntrySchema),
});

export const pluginsInstallParams = z.object({
  id: z.string(),
  /** Optional config override; falls back to the catalog's default config. */
  config: z.record(z.unknown()).optional(),
  /**
   * Secret values keyed by env var. Written to the gateway's secret
   * store (mode 0600) and merged into `process.env` so the plugin reads
   * them transparently. Never written to `config.plugins[].config`.
   */
  secrets: z.record(z.string()).optional(),
});
export const pluginsInstallResult = z.object({
  plugin: pluginRecordSchema,
  /**
   * True when the install was a no-op because the plugin was already
   * loaded. Callers can use this to render an "already installed" notice
   * instead of "Installed".
   */
  alreadyInstalled: z.boolean().optional(),
});

export const pluginsUninstallParams = z.object({ id: z.string() });
export const pluginsUninstallResult = z.object({ id: z.string() });

export const pluginsStartSetupChatParams = z.object({ id: z.string() });
export const pluginsStartSetupChatResult = z.object({
  /** New session id the caller should open in the chat view. */
  sessionId: z.string(),
  /**
   * Text the caller should immediately send through `chat.send` once it has
   * navigated to the new session. We don't auto-fire from inside the
   * gateway — running it through the caller's own connection avoids races
   * where the agent's response streams before the UI is subscribed.
   */
  seedMessage: z.string(),
});

/**
 * One field in a plugin's configure form — what the dashboard / CLI
 * generates a UI from. Mirrors `PluginConfigField` in `@squad/plugin-sdk`,
 * re-declared here so the wire schema doesn't depend on the SDK package.
 */
export const pluginConfigFieldSchema = z.object({
  name: z.string(),
  kind: z.enum(["string", "number", "boolean", "enum", "array", "json"]),
  required: z.boolean(),
  description: z.string().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  secret: z.boolean().optional(),
  envRef: z.boolean().optional(),
});
export type PluginConfigFieldDescription = z.infer<typeof pluginConfigFieldSchema>;

/**
 * One external secret the plugin reads from `process.env` (Discord bot
 * token, OpenAI API key, …). The configure form renders these as password
 * inputs; install writes them to the gateway's secret store, never to
 * `config.plugins[].config`.
 */
export const pluginSecretFieldSchema = z.object({
  envVar: z.string(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  hint: z.string().optional(),
  /** True when the secret is currently set on the gateway. Value is never returned. */
  set: z.boolean(),
});
export type PluginSecretField = z.infer<typeof pluginSecretFieldSchema>;

export const pluginsDescribeParams = z.object({ id: z.string() });
export const pluginsDescribeResult = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Empty array when the plugin has no configSchema. */
  fields: z.array(pluginConfigFieldSchema),
  /** Defaults the catalog ships with (merged on the server before validation). */
  defaultConfig: z.record(z.unknown()),
  /** When loaded/installed, the user's current saved config (with secrets redacted). */
  currentConfig: z.record(z.unknown()).optional(),
  /** True when this plugin needs an entry in `config.auth.tokens[]`. */
  needsAuthToken: z.boolean(),
  /** External env-var secrets the plugin needs (collected separately from config). */
  secrets: z.array(pluginSecretFieldSchema).default([]),
  /** Author-supplied walkthrough of side-quests outside this app. */
  setupPlaybook: z.string().optional(),
});

export const pluginMethods = {
  "plugins.list": { params: pluginsListParams, result: pluginsListResult },
  "plugins.enable": { params: pluginsEnableParams, result: pluginsEnableResult },
  "plugins.disable": { params: pluginsDisableParams, result: pluginsDisableResult },
  "plugins.reload": { params: pluginsReloadParams, result: pluginsReloadResult },
  "plugins.configure": { params: pluginsConfigureParams, result: pluginsConfigureResult },
  "plugins.catalog": { params: pluginsCatalogParams, result: pluginsCatalogResult },
  "plugins.describe": { params: pluginsDescribeParams, result: pluginsDescribeResult },
  "plugins.install": { params: pluginsInstallParams, result: pluginsInstallResult },
  "plugins.uninstall": { params: pluginsUninstallParams, result: pluginsUninstallResult },
  "plugins.start_setup_chat": {
    params: pluginsStartSetupChatParams,
    result: pluginsStartSetupChatResult,
  },
} as const;

export const pluginsChangedEvent = z.object({ plugin: pluginRecordSchema });

export const pluginEvents = {
  "plugins.changed": pluginsChangedEvent,
} as const;
