import type { ChannelCapabilities } from "@squad/protocol";

export const DISCORD_CAPABILITIES: ChannelCapabilities = {
  supportsPreview: true,
  supportsMultiSelect: true,
  supportsFreeText: true,
  maxOptions: 4,
  supportsImages: true,
  supportsFileUploads: true,
  supportsTaskList: true, // D2
  supportsApprovals: true, // D2
};
