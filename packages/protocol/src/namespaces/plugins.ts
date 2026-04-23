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

export const pluginRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  kinds: z.array(pluginKindSchema),
  enabled: z.boolean(),
  config: z.record(z.unknown()).optional(),
  source: z.string(), // path or npm spec
  installedAt: z.string(),
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
