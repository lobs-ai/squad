import type { ChannelCapabilities } from "@squad/protocol";

export const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  supportsPreview: true,
  supportsMultiSelect: true,
  supportsFreeText: true,
  maxOptions: 4,
  supportsImages: false,
  supportsFileUploads: false,
  supportsTaskList: false,
  supportsApprovals: false,
};

export type { ChannelCapabilities };
