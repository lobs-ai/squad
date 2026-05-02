import {
  BaseTool,
  type ToolContext,
  type ToolExecutorResult,
} from "@squad/tools";
import type {
  DiscordBackend,
  DiscordChannelType,
  DiscordEmbedInput,
} from "./types.js";

function ok(payload: unknown): ToolExecutorResult {
  return { result: JSON.stringify(payload) };
}

type AnyTool = BaseTool<Record<string, unknown>>;

// ── discord_message ──────────────────────────────────────────────────────────

interface MessageInput extends Record<string, unknown> {
  action: string;
  channel_id?: string;
  message_id?: string;
  message_ids?: string[];
  content?: string;
  emoji?: string;
  limit?: number;
  before?: string;
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

const messageActions = [
  "send",
  "reply",
  "edit",
  "delete",
  "bulk_delete",
  "fetch",
  "fetch_messages",
  "pin",
  "unpin",
  "send_embed",
  "react",
  "remove_reaction",
] as const;

export class DiscordMessageTool extends BaseTool<MessageInput> {
  readonly name = "discord_message";
  readonly description = [
    "Send, edit, delete, fetch, pin, react, or send-embed Discord messages.",
    "Channel-scoped operations — pass `channel_id` (a thread id is a channel id).",
    `Supported actions: ${messageActions.join(", ")}.`,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...messageActions] },
      channel_id: { type: "string", description: "Channel or thread snowflake." },
      message_id: { type: "string" },
      message_ids: {
        type: "array",
        items: { type: "string" },
        description: "Required for action=bulk_delete (max 100, all <14 days old).",
      },
      content: {
        type: "string",
        description: "Message body for send/reply/edit.",
      },
      emoji: {
        type: "string",
        description:
          "For react/remove_reaction. Unicode (👍) or custom (name:id).",
      },
      limit: {
        type: "number",
        description: "fetch_messages: number to fetch (default 20, max 100).",
      },
      before: {
        type: "string",
        description: "fetch_messages: paginate older messages before this id.",
      },
      title: { type: "string", description: "send_embed: embed title." },
      description: { type: "string", description: "send_embed: embed body." },
      color: { type: "number", description: "send_embed: integer RGB." },
      fields: {
        type: "array",
        description: "send_embed: array of {name, value, inline?}.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            inline: { type: "boolean" },
          },
          required: ["name", "value"],
        },
      },
      footer: { type: "string", description: "send_embed: footer text." },
    },
    required: ["action"],
  };
  readonly tags = ["network"] as const;

  constructor(private readonly backend: DiscordBackend) {
    super();
  }

  async run(input: MessageInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const { action } = input;
    switch (action) {
      case "send": {
        const channelId = required(input.channel_id, "channel_id");
        const content = required(input.content, "content");
        const r = await this.backend.send(channelId, content);
        return ok({ messageId: r.messageId });
      }
      case "reply": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        const content = required(input.content, "content");
        const r = await this.backend.reply(channelId, messageId, content);
        return ok({ messageId: r.messageId });
      }
      case "edit": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        const content = required(input.content, "content");
        const r = await this.backend.editMessage(channelId, messageId, content);
        return ok(r);
      }
      case "delete": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        await this.backend.deleteMessage(channelId, messageId);
        return ok({ ok: true });
      }
      case "bulk_delete": {
        const channelId = required(input.channel_id, "channel_id");
        const ids = input.message_ids;
        if (!Array.isArray(ids) || ids.length === 0) {
          throw new Error("message_ids (non-empty array) is required");
        }
        const r = await this.backend.bulkDeleteMessages(channelId, ids);
        return ok(r);
      }
      case "fetch":
      case "fetch_messages": {
        const channelId = required(input.channel_id, "channel_id");
        const limit = typeof input.limit === "number" ? input.limit : 20;
        const messages = await this.backend.fetchMessages(channelId, limit, input.before);
        return ok({ messages });
      }
      case "pin": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        await this.backend.pinMessage(channelId, messageId);
        return ok({ ok: true });
      }
      case "unpin": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        await this.backend.unpinMessage(channelId, messageId);
        return ok({ ok: true });
      }
      case "send_embed": {
        const channelId = required(input.channel_id, "channel_id");
        const embed: DiscordEmbedInput = {};
        if (input.title !== undefined) embed.title = input.title;
        if (input.description !== undefined) embed.description = input.description;
        if (input.color !== undefined) embed.color = input.color;
        if (input.fields !== undefined) embed.fields = input.fields;
        if (input.footer !== undefined) embed.footer = input.footer;
        if (
          embed.title === undefined &&
          embed.description === undefined &&
          (embed.fields?.length ?? 0) === 0
        ) {
          throw new Error("send_embed needs at least title, description, or fields");
        }
        const r = await this.backend.sendEmbed(channelId, embed);
        return ok(r);
      }
      case "react": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        const emoji = required(input.emoji, "emoji");
        await this.backend.react(channelId, messageId, emoji);
        return ok({ ok: true });
      }
      case "remove_reaction": {
        const channelId = required(input.channel_id, "channel_id");
        const messageId = required(input.message_id, "message_id");
        const emoji = required(input.emoji, "emoji");
        await this.backend.removeReaction(channelId, messageId, emoji);
        return ok({ ok: true });
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }
}

// ── discord_channel ──────────────────────────────────────────────────────────

interface ChannelInput extends Record<string, unknown> {
  action: string;
  guild_id?: string;
  channel_id?: string;
  name?: string;
  channel_type?: DiscordChannelType;
  parent_id?: string;
  topic?: string;
  rate_limit_per_user?: number;
  nsfw?: boolean;
  position?: number;
  overwrite_id?: string;
  overwrite_type?: "role" | "member";
  allow?: string;
  deny?: string;
}

const channelActions = [
  "list",
  "get",
  "create",
  "edit",
  "delete",
  "edit_permissions",
] as const;

export class DiscordChannelTool extends BaseTool<ChannelInput> {
  readonly name = "discord_channel";
  readonly description = [
    "Manage Discord channels — list, get, create, edit, delete, and edit per-role/member",
    "permission overwrites. Threads are managed via discord_thread.",
    `Supported actions: ${channelActions.join(", ")}.`,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...channelActions] },
      guild_id: { type: "string", description: "Required for list, create." },
      channel_id: {
        type: "string",
        description: "Required for get/edit/delete/edit_permissions.",
      },
      name: { type: "string", description: "create/edit: new channel name." },
      channel_type: {
        type: "string",
        enum: ["text", "voice", "category", "announcement", "forum"],
        description: "create: defaults to 'text'.",
      },
      parent_id: {
        type: "string",
        description: "create/edit: category id to nest under.",
      },
      topic: { type: "string" },
      rate_limit_per_user: {
        type: "number",
        description: "Slowmode in seconds.",
      },
      nsfw: { type: "boolean" },
      position: { type: "number" },
      overwrite_id: {
        type: "string",
        description: "edit_permissions: role or user id.",
      },
      overwrite_type: {
        type: "string",
        enum: ["role", "member"],
        description: "edit_permissions: which kind of overwrite.",
      },
      allow: {
        type: "string",
        description: "edit_permissions: permissions bitfield to allow (string).",
      },
      deny: {
        type: "string",
        description: "edit_permissions: permissions bitfield to deny (string).",
      },
    },
    required: ["action"],
  };
  readonly tags = ["network"] as const;

  constructor(private readonly backend: DiscordBackend) {
    super();
  }

  async run(input: ChannelInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    switch (input.action) {
      case "list": {
        const guildId = required(input.guild_id, "guild_id");
        const channels = await this.backend.listChannels(guildId);
        return ok({ channels });
      }
      case "get": {
        const channelId = required(input.channel_id, "channel_id");
        const channel = await this.backend.getChannel(channelId);
        return ok({ channel });
      }
      case "create": {
        const guildId = required(input.guild_id, "guild_id");
        const name = required(input.name, "name");
        const type: DiscordChannelType = input.channel_type ?? "text";
        const channel = await this.backend.createChannel(guildId, name, type, {
          ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.rate_limit_per_user !== undefined
            ? { rateLimitPerUser: input.rate_limit_per_user }
            : {}),
          ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        });
        return ok({ channel });
      }
      case "edit": {
        const channelId = required(input.channel_id, "channel_id");
        const channel = await this.backend.editChannel(channelId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.rate_limit_per_user !== undefined
            ? { rateLimitPerUser: input.rate_limit_per_user }
            : {}),
          ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
        });
        return ok({ channel });
      }
      case "delete": {
        const channelId = required(input.channel_id, "channel_id");
        await this.backend.deleteChannel(channelId);
        return ok({ ok: true });
      }
      case "edit_permissions": {
        const channelId = required(input.channel_id, "channel_id");
        const overwriteId = required(input.overwrite_id, "overwrite_id");
        const overwriteType = required(input.overwrite_type, "overwrite_type");
        if (overwriteType !== "role" && overwriteType !== "member") {
          throw new Error("overwrite_type must be 'role' or 'member'");
        }
        await this.backend.editChannelPermissions(
          channelId,
          overwriteId,
          {
            ...(input.allow !== undefined ? { allow: input.allow } : {}),
            ...(input.deny !== undefined ? { deny: input.deny } : {}),
          },
          overwriteType,
        );
        return ok({ ok: true });
      }
      default:
        throw new Error(`unknown action: ${input.action}`);
    }
  }
}

// ── discord_thread ───────────────────────────────────────────────────────────

interface ThreadInput extends Record<string, unknown> {
  action: string;
  channel_id?: string;
  thread_id?: string;
  user_id?: string;
  message_id?: string;
  name?: string;
  auto_archive_duration?: 60 | 1440 | 4320 | 10080;
  locked?: boolean;
  archived?: boolean;
  applied_tags?: string[];
  rate_limit_per_user?: number;
}

const threadActions = [
  "create",
  "list",
  "edit",
  "delete",
  "archive",
  "unarchive",
  "lock",
  "unlock",
  "add_member",
  "remove_member",
] as const;

export class DiscordThreadTool extends BaseTool<ThreadInput> {
  readonly name = "discord_thread";
  readonly description = [
    "Manage Discord threads. Pass `channel_id` for create/list (the parent),",
    "and `thread_id` for everything else.",
    `Supported actions: ${threadActions.join(", ")}.`,
    "Reading thread messages: use discord_message action=fetch_messages with the thread id.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...threadActions] },
      channel_id: { type: "string", description: "Parent channel for create/list." },
      thread_id: {
        type: "string",
        description: "Required for edit/delete/archive/unarchive/lock/unlock/*_member.",
      },
      user_id: { type: "string", description: "Required for add_member/remove_member." },
      message_id: {
        type: "string",
        description: "create: thread off a specific message.",
      },
      name: { type: "string" },
      auto_archive_duration: {
        type: "number",
        enum: [60, 1440, 4320, 10080],
        description: "Auto-archive in minutes (1h, 1d, 3d, 7d).",
      },
      locked: { type: "boolean" },
      archived: { type: "boolean" },
      applied_tags: {
        type: "array",
        items: { type: "string" },
        description: "Forum tag ids (forum threads only).",
      },
      rate_limit_per_user: { type: "number", description: "Slowmode in seconds." },
    },
    required: ["action"],
  };
  readonly tags = ["network"] as const;

  constructor(private readonly backend: DiscordBackend) {
    super();
  }

  async run(input: ThreadInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    switch (input.action) {
      case "create": {
        const channelId = required(input.channel_id, "channel_id");
        const name = required(input.name, "name");
        const thread = await this.backend.createThread(
          channelId,
          name,
          input.message_id,
          input.auto_archive_duration,
        );
        return ok({ thread });
      }
      case "list": {
        const channelId = required(input.channel_id, "channel_id");
        const threads = await this.backend.listThreads(channelId);
        return ok({ threads });
      }
      case "edit": {
        const threadId = required(input.thread_id, "thread_id");
        const thread = await this.backend.editThread(threadId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.auto_archive_duration !== undefined
            ? { autoArchiveDuration: input.auto_archive_duration }
            : {}),
          ...(input.locked !== undefined ? { locked: input.locked } : {}),
          ...(input.archived !== undefined ? { archived: input.archived } : {}),
          ...(input.applied_tags !== undefined ? { appliedTags: input.applied_tags } : {}),
          ...(input.rate_limit_per_user !== undefined
            ? { rateLimitPerUser: input.rate_limit_per_user }
            : {}),
        });
        return ok({ thread });
      }
      case "delete": {
        const threadId = required(input.thread_id, "thread_id");
        await this.backend.deleteThread(threadId);
        return ok({ ok: true });
      }
      case "archive": {
        await this.backend.archiveThread(required(input.thread_id, "thread_id"));
        return ok({ ok: true });
      }
      case "unarchive": {
        await this.backend.unarchiveThread(required(input.thread_id, "thread_id"));
        return ok({ ok: true });
      }
      case "lock": {
        await this.backend.lockThread(required(input.thread_id, "thread_id"));
        return ok({ ok: true });
      }
      case "unlock": {
        await this.backend.unlockThread(required(input.thread_id, "thread_id"));
        return ok({ ok: true });
      }
      case "add_member": {
        const threadId = required(input.thread_id, "thread_id");
        const userId = required(input.user_id, "user_id");
        await this.backend.addThreadMember(threadId, userId);
        return ok({ ok: true });
      }
      case "remove_member": {
        const threadId = required(input.thread_id, "thread_id");
        const userId = required(input.user_id, "user_id");
        await this.backend.removeThreadMember(threadId, userId);
        return ok({ ok: true });
      }
      default:
        throw new Error(`unknown action: ${input.action}`);
    }
  }
}

// ── discord_webhook ──────────────────────────────────────────────────────────

interface WebhookInput extends Record<string, unknown> {
  action: string;
  channel_id?: string;
  name?: string;
  webhook_id?: string;
  webhook_token?: string;
  content?: string;
  username?: string;
  avatar_url?: string;
}

const webhookActions = ["create", "list", "post"] as const;

export class DiscordWebhookTool extends BaseTool<WebhookInput> {
  readonly name = "discord_webhook";
  readonly description = [
    "Manage Discord webhooks — create, list per channel, or post via an existing webhook.",
    "Posting via webhook lets you set username/avatar per message and bypass bot rate limits.",
    `Supported actions: ${webhookActions.join(", ")}.`,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...webhookActions] },
      channel_id: {
        type: "string",
        description: "Required for create and list (channel scope).",
      },
      name: { type: "string", description: "Required for create." },
      webhook_id: { type: "string", description: "Required for post." },
      webhook_token: { type: "string", description: "Required for post." },
      content: { type: "string", description: "Required for post." },
      username: { type: "string", description: "post: override display name." },
      avatar_url: { type: "string", description: "post: override avatar." },
    },
    required: ["action"],
  };
  readonly tags = ["network"] as const;

  constructor(private readonly backend: DiscordBackend) {
    super();
  }

  async run(input: WebhookInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    switch (input.action) {
      case "create": {
        const channelId = required(input.channel_id, "channel_id");
        const name = required(input.name, "name");
        const webhook = await this.backend.createWebhook(channelId, name);
        return ok({ webhook });
      }
      case "list": {
        const channelId = required(input.channel_id, "channel_id");
        const webhooks = await this.backend.listWebhooks(channelId);
        return ok({ webhooks });
      }
      case "post": {
        const id = required(input.webhook_id, "webhook_id");
        const token = required(input.webhook_token, "webhook_token");
        const content = required(input.content, "content");
        const r = await this.backend.postWebhook(id, token, content, {
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.avatar_url !== undefined ? { avatarUrl: input.avatar_url } : {}),
        });
        return ok(r);
      }
      default:
        throw new Error(`unknown action: ${input.action}`);
    }
  }
}

// ── discord_server ───────────────────────────────────────────────────────────

interface ServerInput extends Record<string, unknown> {
  action: string;
  guild_id?: string;
  user_id?: string;
}

const serverActions = ["get_guild", "get_member", "list_roles"] as const;

export class DiscordServerTool extends BaseTool<ServerInput> {
  readonly name = "discord_server";
  readonly description = [
    "Read Discord guild metadata, members, and roles.",
    `Supported actions: ${serverActions.join(", ")}.`,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...serverActions] },
      guild_id: { type: "string", description: "Always required." },
      user_id: { type: "string", description: "Required for get_member." },
    },
    required: ["action", "guild_id"],
  };
  readonly tags = ["readonly", "network"] as const;

  constructor(private readonly backend: DiscordBackend) {
    super();
  }

  async run(input: ServerInput, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const guildId = required(input.guild_id, "guild_id");
    switch (input.action) {
      case "get_guild": {
        const guild = await this.backend.getGuild(guildId);
        return ok({ guild });
      }
      case "get_member": {
        const userId = required(input.user_id, "user_id");
        const member = await this.backend.getMember(guildId, userId);
        return ok({ member });
      }
      case "list_roles": {
        const roles = await this.backend.listRoles(guildId);
        return ok({ roles });
      }
      default:
        throw new Error(`unknown action: ${input.action}`);
    }
  }
}

// ── registration helper ─────────────────────────────────────────────────────

export function registerDiscordTools(
  registry: { register(tool: AnyTool): unknown },
  backend: DiscordBackend,
): void {
  registry.register(new DiscordMessageTool(backend) as unknown as AnyTool);
  registry.register(new DiscordChannelTool(backend) as unknown as AnyTool);
  registry.register(new DiscordThreadTool(backend) as unknown as AnyTool);
  registry.register(new DiscordWebhookTool(backend) as unknown as AnyTool);
  registry.register(new DiscordServerTool(backend) as unknown as AnyTool);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
