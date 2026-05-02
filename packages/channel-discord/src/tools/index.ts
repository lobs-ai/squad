export type {
  DiscordBackend,
  DiscordMessageSummary,
  DiscordChannelSummary,
  DiscordThreadSummary,
  DiscordWebhookSummary,
  DiscordGuildSummary,
  DiscordMemberSummary,
  DiscordRoleSummary,
  DiscordEmbedInput,
  DiscordChannelType,
  CreateChannelOptions,
  EditChannelOptions,
  EditChannelPermissionsOptions,
  EditThreadOptions,
  PostWebhookOptions,
} from "./types.js";

export {
  DiscordMessageTool,
  DiscordChannelTool,
  DiscordThreadTool,
  DiscordWebhookTool,
  DiscordServerTool,
  registerDiscordTools,
} from "./tools.js";

export { DISCORD_GUIDANCE } from "./prompt.js";

import type { ToolGroup } from "@squad/tools";
import { DISCORD_GUIDANCE } from "./prompt.js";

/**
 * Lazy-loadable tool group for Discord interactions. Available only when the
 * channel-discord plugin is loaded — the plugin registers the executors into
 * the gateway's tool registry against a live bot.
 */
export const discordGroup: ToolGroup = {
  name: "discord",
  description:
    "Read and write Discord — messages, reactions, channels, threads, webhooks, server/member/role lookups",
  toolNames: [
    "discord_message",
    "discord_channel",
    "discord_thread",
    "discord_webhook",
    "discord_server",
  ],
  guidance: DISCORD_GUIDANCE,
};
