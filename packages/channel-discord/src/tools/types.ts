/**
 * DiscordBackend — minimal interface the Discord tools talk to.
 *
 * The channel-discord plugin implements this against Carbon's REST client;
 * tests stub it. Tools never import from the channel package directly so
 * the @squad/tools package stays Discord-library-free.
 */

export interface DiscordMessageSummary {
  id: string;
  channelId: string;
  authorId: string;
  authorUsername: string | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Array<{ id: string; url: string; filename: string }>;
  referencedMessageId: string | null;
  pinned: boolean;
}

export interface DiscordChannelSummary {
  id: string;
  guildId: string | null;
  name: string | null;
  type: number;
  parentId: string | null;
  topic: string | null;
  nsfw: boolean;
  position: number | null;
  rateLimitPerUser: number | null;
}

export interface DiscordThreadSummary {
  id: string;
  parentId: string | null;
  name: string;
  archived: boolean;
  locked: boolean;
  autoArchiveDuration: number | null;
  ownerId: string | null;
  memberCount: number | null;
  messageCount: number | null;
}

export interface DiscordWebhookSummary {
  id: string;
  channelId: string;
  guildId: string | null;
  name: string;
  /** Only present when fetched via createWebhook (the API only returns the
   *  token at creation time). */
  token?: string;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  ownerId: string;
  memberCount: number | null;
  description: string | null;
}

export interface DiscordMemberSummary {
  userId: string;
  username: string | null;
  displayName: string | null;
  joinedAt: string | null;
  roleIds: string[];
  bot: boolean;
}

export interface DiscordRoleSummary {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
}

export interface DiscordEmbedInput {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
  url?: string;
  timestamp?: string;
}

export type DiscordChannelType =
  | "text"
  | "voice"
  | "category"
  | "announcement"
  | "forum";

export interface CreateChannelOptions {
  parentId?: string;
  topic?: string;
  rateLimitPerUser?: number;
  nsfw?: boolean;
  position?: number;
}

export interface EditChannelOptions {
  name?: string;
  topic?: string;
  rateLimitPerUser?: number;
  nsfw?: boolean;
  position?: number;
  parentId?: string;
}

export interface EditChannelPermissionsOptions {
  /** Permissions to allow as a Discord permissions bitfield (string). */
  allow?: string;
  /** Permissions to deny as a Discord permissions bitfield (string). */
  deny?: string;
}

export interface EditThreadOptions {
  name?: string;
  autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
  locked?: boolean;
  archived?: boolean;
  appliedTags?: string[];
  rateLimitPerUser?: number;
}

export interface PostWebhookOptions {
  username?: string;
  avatarUrl?: string;
  embeds?: DiscordEmbedInput[];
}

export interface DiscordBackend {
  // ── messages ────────────────────────────────────────────────────────────
  send(channelId: string, content: string): Promise<{ messageId: string }>;
  reply(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<{ messageId: string }>;
  editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<{ messageId: string }>;
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  bulkDeleteMessages(
    channelId: string,
    messageIds: string[],
  ): Promise<{ deleted: number }>;
  fetchMessages(
    channelId: string,
    limit?: number,
    before?: string,
  ): Promise<DiscordMessageSummary[]>;
  fetchMessage(
    channelId: string,
    messageId: string,
  ): Promise<DiscordMessageSummary | null>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  unpinMessage(channelId: string, messageId: string): Promise<void>;
  sendEmbed(channelId: string, embed: DiscordEmbedInput): Promise<{ messageId: string }>;

  // ── reactions ───────────────────────────────────────────────────────────
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;

  // ── channels ────────────────────────────────────────────────────────────
  listChannels(guildId: string): Promise<DiscordChannelSummary[]>;
  getChannel(channelId: string): Promise<DiscordChannelSummary>;
  createChannel(
    guildId: string,
    name: string,
    type: DiscordChannelType,
    opts?: CreateChannelOptions,
  ): Promise<DiscordChannelSummary>;
  editChannel(
    channelId: string,
    opts: EditChannelOptions,
  ): Promise<DiscordChannelSummary>;
  deleteChannel(channelId: string): Promise<void>;
  editChannelPermissions(
    channelId: string,
    overwriteId: string,
    opts: EditChannelPermissionsOptions,
    overwriteType: "role" | "member",
  ): Promise<void>;

  // ── threads ─────────────────────────────────────────────────────────────
  createThread(
    channelId: string,
    name: string,
    messageId?: string,
    autoArchiveDuration?: number,
  ): Promise<DiscordThreadSummary>;
  listThreads(channelId: string): Promise<DiscordThreadSummary[]>;
  editThread(threadId: string, opts: EditThreadOptions): Promise<DiscordThreadSummary>;
  deleteThread(threadId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  lockThread(threadId: string): Promise<void>;
  unlockThread(threadId: string): Promise<void>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  removeThreadMember(threadId: string, userId: string): Promise<void>;

  // ── webhooks ────────────────────────────────────────────────────────────
  createWebhook(channelId: string, name: string): Promise<DiscordWebhookSummary>;
  listWebhooks(channelId: string): Promise<DiscordWebhookSummary[]>;
  postWebhook(
    webhookId: string,
    webhookToken: string,
    content: string,
    opts?: PostWebhookOptions,
  ): Promise<{ messageId: string | null }>;

  // ── server / members / roles ────────────────────────────────────────────
  getGuild(guildId: string): Promise<DiscordGuildSummary>;
  getMember(guildId: string, userId: string): Promise<DiscordMemberSummary>;
  listRoles(guildId: string): Promise<DiscordRoleSummary[]>;
}
