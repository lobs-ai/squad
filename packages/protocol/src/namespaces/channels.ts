import { z } from "zod";

export const channelCapabilitiesSchema = z.object({
  supportsPreview: z.boolean(),
  supportsMultiSelect: z.boolean(),
  supportsFreeText: z.boolean(),
  maxOptions: z.number().int().positive(),
  supportsImages: z.boolean().default(false),
  supportsFileUploads: z.boolean().default(false),
  supportsTaskList: z.boolean().default(false),
  supportsApprovals: z.boolean().default(false),
});
export type ChannelCapabilities = z.infer<typeof channelCapabilitiesSchema>;

export const channelRecordSchema = z.object({
  id: z.string(),
  kind: z.string(), // e.g. "discord"
  label: z.string(),
  connected: z.boolean(),
  capabilities: channelCapabilitiesSchema,
});
export type ChannelRecord = z.infer<typeof channelRecordSchema>;

export const channelBindingSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  sessionId: z.string(),
  route: z.record(z.unknown()), // channel-defined (e.g. {guildId, channelId})
});
export type ChannelBinding = z.infer<typeof channelBindingSchema>;

// channels.list
export const channelsListParams = z.object({}).optional();
export const channelsListResult = z.object({ channels: z.array(channelRecordSchema) });

// channels.bind
export const channelsBindParams = z.object({
  channelId: z.string(),
  sessionId: z.string(),
  route: z.record(z.unknown()),
});
export const channelsBindResult = z.object({ binding: channelBindingSchema });

// channels.unbind
export const channelsUnbindParams = z.object({ bindingId: z.string() });
export const channelsUnbindResult = z.object({ bindingId: z.string() });

// channels.capabilities
export const channelsCapabilitiesParams = z.object({ channelId: z.string() });
export const channelsCapabilitiesResult = z.object({
  channelId: z.string(),
  capabilities: channelCapabilitiesSchema,
});

export const channelMethods = {
  "channels.list": { params: channelsListParams, result: channelsListResult },
  "channels.bind": { params: channelsBindParams, result: channelsBindResult },
  "channels.unbind": { params: channelsUnbindParams, result: channelsUnbindResult },
  "channels.capabilities": {
    params: channelsCapabilitiesParams,
    result: channelsCapabilitiesResult,
  },
} as const;
