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

export const pluginMethods = {
  "plugins.list": { params: pluginsListParams, result: pluginsListResult },
  "plugins.enable": { params: pluginsEnableParams, result: pluginsEnableResult },
  "plugins.disable": { params: pluginsDisableParams, result: pluginsDisableResult },
  "plugins.reload": { params: pluginsReloadParams, result: pluginsReloadResult },
  "plugins.configure": { params: pluginsConfigureParams, result: pluginsConfigureResult },
} as const;

export const pluginsChangedEvent = z.object({ plugin: pluginRecordSchema });

export const pluginEvents = {
  "plugins.changed": pluginsChangedEvent,
} as const;
