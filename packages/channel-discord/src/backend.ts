import type {
  CreateChannelOptions,
  DiscordBackend,
  DiscordChannelSummary,
  DiscordChannelType,
  DiscordEmbedInput,
  DiscordGuildSummary,
  DiscordMemberSummary,
  DiscordMessageSummary,
  DiscordRoleSummary,
  DiscordThreadSummary,
  DiscordWebhookSummary,
  EditChannelOptions,
  EditChannelPermissionsOptions,
  EditThreadOptions,
  PostWebhookOptions,
} from "./tools/index.js";
import type { BotHandle, BotLogger } from "./bot.js";
import { chunkMessage } from "./formatting.js";

/**
 * Resolves the live bot when each tool call fires. The plugin hands a
 * function (rather than the BotHandle directly) because tools are registered
 * synchronously at boot but the gateway connection is established later.
 */
export type BotResolver = () => BotHandle;

/**
 * Carbon's REST client returns `unknown` — we narrow to the few Discord API
 * shapes we actually consume below, keeping the surface obvious without
 * dragging the entire discord-api-types tree into the build.
 */
interface ApiMessage {
  id: string;
  channel_id: string;
  author?: { id?: string; username?: string };
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  attachments?: Array<{ id?: string; url?: string; filename?: string }>;
  message_reference?: { message_id?: string };
  pinned?: boolean;
}

interface ApiChannel {
  id: string;
  guild_id?: string | null;
  name?: string | null;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  position?: number;
  rate_limit_per_user?: number;
  thread_metadata?: {
    archived?: boolean;
    locked?: boolean;
    auto_archive_duration?: number;
  };
  owner_id?: string;
  member_count?: number;
  message_count?: number;
}

interface ApiThreadList {
  threads?: ApiChannel[];
}

interface ApiWebhook {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  name?: string | null;
  token?: string;
}

interface ApiGuild {
  id: string;
  name: string;
  owner_id: string;
  approximate_member_count?: number;
  member_count?: number;
  description?: string | null;
}

interface ApiMember {
  user?: { id: string; username?: string; bot?: boolean };
  nick?: string | null;
  joined_at?: string;
  roles?: string[];
}

interface ApiRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
}

const CHANNEL_TYPE_MAP: Record<DiscordChannelType, number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  forum: 15,
};

/**
 * REST-only Discord backend. Talks to the Discord HTTP API through Carbon's
 * `client.rest`, which the channel plugin already uses for outbound posts.
 * No state of its own — every call resolves the live bot via the supplied
 * resolver, so the same backend instance keeps working across reconnects.
 */
export class CarbonDiscordBackend implements DiscordBackend {
  constructor(
    private readonly resolveBot: BotResolver,
    private readonly logger?: BotLogger,
  ) {}

  private get rest(): BotHandle["client"]["rest"] {
    return this.resolveBot().client.rest;
  }

  /** userId → DM channelId, memoised so we don't reopen on every send. */
  private readonly dmChannelByUser = new Map<string, string>();

  async openDm(userId: string): Promise<{ channelId: string }> {
    const cached = this.dmChannelByUser.get(userId);
    if (cached) return { channelId: cached };
    const r = (await this.rest.post(`/users/@me/channels`, {
      body: { recipient_id: userId },
    })) as ApiChannel;
    this.dmChannelByUser.set(userId, r.id);
    return { channelId: r.id };
  }

  /**
   * Runs `op(channelId)`. If it fails with an error that looks like the id
   * isn't a channel the bot can see (Missing Access / Unknown Channel), try
   * treating `channelId` as a user id, open a DM, and retry against the DM
   * channel. The retry's failure (or the DM-open failure) propagates the
   * *original* error so callers still see the real problem when the id was
   * genuinely just a bad channel.
   */
  private async withDmFallback<T>(
    channelId: string,
    op: (cid: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await op(channelId);
    } catch (err) {
      if (!looksLikeChannelInaccessible(err)) throw err;
      let dmChannelId: string;
      try {
        dmChannelId = (await this.openDm(channelId)).channelId;
      } catch {
        throw err;
      }
      this.logger?.info(
        { userId: channelId, dmChannelId },
        "discord backend: retrying message send against opened DM channel",
      );
      try {
        return await op(dmChannelId);
      } catch {
        throw err;
      }
    }
  }

  // ── messages ────────────────────────────────────────────────────────────

  async send(channelId: string, content: string): Promise<{ messageId: string }> {
    return this.withDmFallback(channelId, async (cid) => {
      const r = (await this.rest.post(`/channels/${cid}/messages`, {
        body: { content },
      })) as ApiMessage;
      return { messageId: r.id };
    });
  }

  async reply(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<{ messageId: string }> {
    return this.withDmFallback(channelId, async (cid) => {
      const r = (await this.rest.post(`/channels/${cid}/messages`, {
        body: { content, message_reference: { message_id: messageId } },
      })) as ApiMessage;
      return { messageId: r.id };
    });
  }

  async editMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<{ messageId: string }> {
    const r = (await this.rest.patch(
      `/channels/${channelId}/messages/${messageId}`,
      { body: { content } },
    )) as ApiMessage;
    return { messageId: r.id };
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}/messages/${messageId}`);
  }

  async bulkDeleteMessages(
    channelId: string,
    messageIds: string[],
  ): Promise<{ deleted: number }> {
    if (messageIds.length === 1) {
      await this.deleteMessage(channelId, messageIds[0]!);
      return { deleted: 1 };
    }
    await this.rest.post(`/channels/${channelId}/messages/bulk-delete`, {
      body: { messages: messageIds },
    });
    return { deleted: messageIds.length };
  }

  async fetchMessages(
    channelId: string,
    limit = 20,
    before?: string,
  ): Promise<DiscordMessageSummary[]> {
    const query: Record<string, string> = { limit: String(Math.min(100, Math.max(1, limit))) };
    if (before) query.before = before;
    const r = (await this.rest.get(`/channels/${channelId}/messages`, query)) as ApiMessage[];
    return r.map(toMessageSummary);
  }

  async fetchMessage(
    channelId: string,
    messageId: string,
  ): Promise<DiscordMessageSummary | null> {
    try {
      const r = (await this.rest.get(
        `/channels/${channelId}/messages/${messageId}`,
      )) as ApiMessage;
      return toMessageSummary(r);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    await this.rest.put(`/channels/${channelId}/pins/${messageId}`);
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}/pins/${messageId}`);
  }

  async sendEmbed(
    channelId: string,
    embed: DiscordEmbedInput,
  ): Promise<{ messageId: string }> {
    return this.withDmFallback(channelId, async (cid) => {
      const r = (await this.rest.post(`/channels/${cid}/messages`, {
        body: { embeds: [toApiEmbed(embed)] },
      })) as ApiMessage;
      return { messageId: r.id };
    });
  }

  // ── reactions ───────────────────────────────────────────────────────────

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const enc = encodeURIComponent(emoji);
    await this.rest.put(
      `/channels/${channelId}/messages/${messageId}/reactions/${enc}/@me`,
    );
  }

  async removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const enc = encodeURIComponent(emoji);
    await this.rest.delete(
      `/channels/${channelId}/messages/${messageId}/reactions/${enc}/@me`,
    );
  }

  // ── channels ────────────────────────────────────────────────────────────

  async listChannels(guildId: string): Promise<DiscordChannelSummary[]> {
    const r = (await this.rest.get(`/guilds/${guildId}/channels`)) as ApiChannel[];
    return r.map(toChannelSummary);
  }

  async getChannel(channelId: string): Promise<DiscordChannelSummary> {
    const r = (await this.rest.get(`/channels/${channelId}`)) as ApiChannel;
    return toChannelSummary(r);
  }

  async createChannel(
    guildId: string,
    name: string,
    type: DiscordChannelType,
    opts: CreateChannelOptions = {},
  ): Promise<DiscordChannelSummary> {
    const body: Record<string, unknown> = {
      name,
      type: CHANNEL_TYPE_MAP[type],
    };
    if (opts.parentId !== undefined) body.parent_id = opts.parentId;
    if (opts.topic !== undefined) body.topic = opts.topic;
    if (opts.rateLimitPerUser !== undefined) body.rate_limit_per_user = opts.rateLimitPerUser;
    if (opts.nsfw !== undefined) body.nsfw = opts.nsfw;
    if (opts.position !== undefined) body.position = opts.position;
    const r = (await this.rest.post(`/guilds/${guildId}/channels`, { body })) as ApiChannel;
    return toChannelSummary(r);
  }

  async editChannel(
    channelId: string,
    opts: EditChannelOptions,
  ): Promise<DiscordChannelSummary> {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.topic !== undefined) body.topic = opts.topic;
    if (opts.rateLimitPerUser !== undefined) body.rate_limit_per_user = opts.rateLimitPerUser;
    if (opts.nsfw !== undefined) body.nsfw = opts.nsfw;
    if (opts.position !== undefined) body.position = opts.position;
    if (opts.parentId !== undefined) body.parent_id = opts.parentId;
    const r = (await this.rest.patch(`/channels/${channelId}`, { body })) as ApiChannel;
    return toChannelSummary(r);
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.rest.delete(`/channels/${channelId}`);
  }

  async editChannelPermissions(
    channelId: string,
    overwriteId: string,
    opts: EditChannelPermissionsOptions,
    overwriteType: "role" | "member",
  ): Promise<void> {
    const body: Record<string, unknown> = { type: overwriteType === "role" ? 0 : 1 };
    if (opts.allow !== undefined) body.allow = opts.allow;
    if (opts.deny !== undefined) body.deny = opts.deny;
    await this.rest.put(`/channels/${channelId}/permissions/${overwriteId}`, { body });
  }

  // ── threads ─────────────────────────────────────────────────────────────

  async createThread(
    channelId: string,
    name: string,
    messageId?: string,
    autoArchiveDuration?: number,
  ): Promise<DiscordThreadSummary> {
    const body: Record<string, unknown> = { name };
    if (autoArchiveDuration !== undefined) body.auto_archive_duration = autoArchiveDuration;
    if (!messageId) body.type = 11; // PUBLIC_THREAD off the channel itself
    const path = messageId
      ? `/channels/${channelId}/messages/${messageId}/threads`
      : `/channels/${channelId}/threads`;
    const r = (await this.rest.post(path, { body })) as ApiChannel;
    return toThreadSummary(r);
  }

  async listThreads(channelId: string): Promise<DiscordThreadSummary[]> {
    const active = (await this.rest
      .get(`/channels/${channelId}/threads/active`)
      .catch((err: unknown) => {
        this.logger?.warn(
          { err, channelId },
          "discord backend: listThreads failed — returning empty list",
        );
        return { threads: [] };
      })) as ApiThreadList;
    return (active.threads ?? []).map(toThreadSummary);
  }

  async editThread(
    threadId: string,
    opts: EditThreadOptions,
  ): Promise<DiscordThreadSummary> {
    const body: Record<string, unknown> = {};
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.autoArchiveDuration !== undefined) body.auto_archive_duration = opts.autoArchiveDuration;
    if (opts.locked !== undefined) body.locked = opts.locked;
    if (opts.archived !== undefined) body.archived = opts.archived;
    if (opts.appliedTags !== undefined) body.applied_tags = opts.appliedTags;
    if (opts.rateLimitPerUser !== undefined) body.rate_limit_per_user = opts.rateLimitPerUser;
    const r = (await this.rest.patch(`/channels/${threadId}`, { body })) as ApiChannel;
    return toThreadSummary(r);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.rest.delete(`/channels/${threadId}`);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.rest.patch(`/channels/${threadId}`, { body: { archived: true } });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.rest.patch(`/channels/${threadId}`, { body: { archived: false } });
  }

  async lockThread(threadId: string): Promise<void> {
    await this.rest.patch(`/channels/${threadId}`, { body: { locked: true } });
  }

  async unlockThread(threadId: string): Promise<void> {
    await this.rest.patch(`/channels/${threadId}`, { body: { locked: false } });
  }

  async addThreadMember(threadId: string, userId: string): Promise<void> {
    await this.rest.put(`/channels/${threadId}/thread-members/${userId}`);
  }

  async removeThreadMember(threadId: string, userId: string): Promise<void> {
    await this.rest.delete(`/channels/${threadId}/thread-members/${userId}`);
  }

  // ── webhooks ────────────────────────────────────────────────────────────

  async createWebhook(channelId: string, name: string): Promise<DiscordWebhookSummary> {
    const r = (await this.rest.post(`/channels/${channelId}/webhooks`, {
      body: { name },
    })) as ApiWebhook;
    return toWebhookSummary(r);
  }

  async listWebhooks(channelId: string): Promise<DiscordWebhookSummary[]> {
    const r = (await this.rest.get(`/channels/${channelId}/webhooks`)) as ApiWebhook[];
    return r.map(toWebhookSummary);
  }

  async postWebhook(
    webhookId: string,
    webhookToken: string,
    content: string,
    opts: PostWebhookOptions = {},
  ): Promise<{ messageId: string | null }> {
    const limit = 1900;
    const chunks = chunkMessage(content || "(empty)", limit);
    let last: ApiMessage | null = null;
    for (const chunk of chunks) {
      const body: Record<string, unknown> = { content: chunk };
      if (opts.username !== undefined) body.username = opts.username;
      if (opts.avatarUrl !== undefined) body.avatar_url = opts.avatarUrl;
      if (opts.embeds !== undefined && opts.embeds.length > 0) {
        body.embeds = opts.embeds.map(toApiEmbed);
      }
      // wait=true returns the resulting message (with id) so we can echo it
      // back to the caller; without it Discord returns 204 No Content.
      last = (await this.rest.post(
        `/webhooks/${webhookId}/${webhookToken}`,
        { body },
        { wait: "true" },
      )) as ApiMessage;
    }
    return { messageId: last?.id ?? null };
  }

  // ── server / members / roles ────────────────────────────────────────────

  async getGuild(guildId: string): Promise<DiscordGuildSummary> {
    const r = (await this.rest.get(`/guilds/${guildId}`, {
      with_counts: "true",
    })) as ApiGuild;
    return {
      id: r.id,
      name: r.name,
      ownerId: r.owner_id,
      memberCount: r.approximate_member_count ?? r.member_count ?? null,
      description: r.description ?? null,
    };
  }

  async getMember(guildId: string, userId: string): Promise<DiscordMemberSummary> {
    const r = (await this.rest.get(
      `/guilds/${guildId}/members/${userId}`,
    )) as ApiMember;
    return {
      userId: r.user?.id ?? userId,
      username: r.user?.username ?? null,
      displayName: r.nick ?? r.user?.username ?? null,
      joinedAt: r.joined_at ?? null,
      roleIds: r.roles ?? [],
      bot: r.user?.bot === true,
    };
  }

  async listRoles(guildId: string): Promise<DiscordRoleSummary[]> {
    const r = (await this.rest.get(`/guilds/${guildId}/roles`)) as ApiRole[];
    return r.map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      position: role.position,
      permissions: role.permissions,
      managed: role.managed,
      mentionable: role.mentionable,
    }));
  }
}

// ── shape adapters ──────────────────────────────────────────────────────────

function toMessageSummary(m: ApiMessage): DiscordMessageSummary {
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author?.id ?? "",
    authorUsername: m.author?.username ?? null,
    content: m.content ?? "",
    createdAt: m.timestamp ?? "",
    editedAt: m.edited_timestamp ?? null,
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id ?? "",
      url: a.url ?? "",
      filename: a.filename ?? "",
    })),
    referencedMessageId: m.message_reference?.message_id ?? null,
    pinned: m.pinned === true,
  };
}

function toChannelSummary(c: ApiChannel): DiscordChannelSummary {
  return {
    id: c.id,
    guildId: c.guild_id ?? null,
    name: c.name ?? null,
    type: c.type,
    parentId: c.parent_id ?? null,
    topic: c.topic ?? null,
    nsfw: c.nsfw === true,
    position: c.position ?? null,
    rateLimitPerUser: c.rate_limit_per_user ?? null,
  };
}

function toThreadSummary(c: ApiChannel): DiscordThreadSummary {
  return {
    id: c.id,
    parentId: c.parent_id ?? null,
    name: c.name ?? "",
    archived: c.thread_metadata?.archived === true,
    locked: c.thread_metadata?.locked === true,
    autoArchiveDuration: c.thread_metadata?.auto_archive_duration ?? null,
    ownerId: c.owner_id ?? null,
    memberCount: c.member_count ?? null,
    messageCount: c.message_count ?? null,
  };
}

function toWebhookSummary(w: ApiWebhook): DiscordWebhookSummary {
  return {
    id: w.id,
    channelId: w.channel_id,
    guildId: w.guild_id ?? null,
    name: w.name ?? "",
    ...(w.token !== undefined ? { token: w.token } : {}),
  };
}

function toApiEmbed(e: DiscordEmbedInput): Record<string, unknown> {
  const embed: Record<string, unknown> = {};
  if (e.title !== undefined) embed.title = e.title;
  if (e.description !== undefined) embed.description = e.description;
  if (e.color !== undefined) embed.color = e.color;
  if (e.url !== undefined) embed.url = e.url;
  if (e.timestamp !== undefined) embed.timestamp = e.timestamp;
  if (e.fields !== undefined) embed.fields = e.fields;
  if (e.footer !== undefined) embed.footer = { text: e.footer };
  return embed;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;
  if (obj.status === 404 || obj.statusCode === 404) return true;
  const msg = err instanceof Error ? err.message : "";
  return /\b404\b/.test(msg);
}

/**
 * Heuristic for "the id passed as a channel is not actually a channel the bot
 * can post into" — the cue we use to retry as a DM. Matches Discord error
 * codes 50001 (Missing Access) and 10003 (Unknown Channel), plus HTTP 403/404
 * shapes as a fallback for clients that don't surface the JSON code.
 */
function looksLikeChannelInaccessible(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const obj = err as Record<string, unknown>;
  const code = obj.discordCode ?? obj.code;
  if (code === 50001 || code === 10003) return true;
  const status = obj.status ?? obj.statusCode;
  if (status === 403 || status === 404) return true;
  const msg = err instanceof Error ? err.message : "";
  return /Missing Access|Unknown Channel\b/i.test(msg);
}
