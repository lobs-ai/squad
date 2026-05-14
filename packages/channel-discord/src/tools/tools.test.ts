import { describe, expect, it, vi } from "vitest";
import {
  DiscordChannelTool,
  DiscordMessageTool,
  DiscordServerTool,
  DiscordThreadTool,
  DiscordWebhookTool,
} from "./tools.js";
import type { DiscordBackend } from "./types.js";
import { discordGroup } from "./index.js";

function stubBackend(): DiscordBackend {
  return {
    openDm: vi.fn(async (userId: string) => ({ channelId: `dm:${userId}` })),
    send: vi.fn(async () => ({ messageId: "m1" })),
    reply: vi.fn(async () => ({ messageId: "m2" })),
    editMessage: vi.fn(async () => ({ messageId: "m3" })),
    deleteMessage: vi.fn(async () => undefined),
    bulkDeleteMessages: vi.fn(async (_c, ids) => ({ deleted: ids.length })),
    fetchMessages: vi.fn(async () => []),
    fetchMessage: vi.fn(async () => null),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => undefined),
    sendEmbed: vi.fn(async () => ({ messageId: "e1" })),
    react: vi.fn(async () => undefined),
    removeReaction: vi.fn(async () => undefined),
    listChannels: vi.fn(async () => []),
    getChannel: vi.fn(async () => ({
      id: "c1",
      guildId: "g1",
      name: "general",
      type: 0,
      parentId: null,
      topic: null,
      nsfw: false,
      position: 0,
      rateLimitPerUser: null,
    })),
    createChannel: vi.fn(async (_g, name) => ({
      id: "c2",
      guildId: "g1",
      name,
      type: 0,
      parentId: null,
      topic: null,
      nsfw: false,
      position: 0,
      rateLimitPerUser: null,
    })),
    editChannel: vi.fn(async (id) => ({
      id,
      guildId: "g1",
      name: "edited",
      type: 0,
      parentId: null,
      topic: null,
      nsfw: false,
      position: 0,
      rateLimitPerUser: null,
    })),
    deleteChannel: vi.fn(async () => undefined),
    editChannelPermissions: vi.fn(async () => undefined),
    createThread: vi.fn(async (_c, name) => ({
      id: "t1",
      parentId: "c1",
      name,
      archived: false,
      locked: false,
      autoArchiveDuration: 1440,
      ownerId: null,
      memberCount: 1,
      messageCount: 0,
    })),
    listThreads: vi.fn(async () => []),
    editThread: vi.fn(async (id) => ({
      id,
      parentId: "c1",
      name: "edited",
      archived: false,
      locked: false,
      autoArchiveDuration: 1440,
      ownerId: null,
      memberCount: 1,
      messageCount: 0,
    })),
    deleteThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    lockThread: vi.fn(async () => undefined),
    unlockThread: vi.fn(async () => undefined),
    addThreadMember: vi.fn(async () => undefined),
    removeThreadMember: vi.fn(async () => undefined),
    createWebhook: vi.fn(async (_c, name) => ({
      id: "w1",
      channelId: "c1",
      guildId: "g1",
      name,
      token: "tok",
    })),
    listWebhooks: vi.fn(async () => []),
    postWebhook: vi.fn(async () => ({ messageId: "wm1" })),
    getGuild: vi.fn(async (id) => ({
      id,
      name: "g",
      ownerId: "u1",
      memberCount: 2,
      description: null,
    })),
    getMember: vi.fn(async (_g, userId) => ({
      userId,
      username: "u",
      displayName: "u",
      joinedAt: null,
      roleIds: [],
      bot: false,
    })),
    listRoles: vi.fn(async () => []),
  };
}

const ctx = { cwd: "/tmp" };

describe("discordGroup", () => {
  it("is lazy (not default) and lists every tool name", () => {
    expect(discordGroup.name).toBe("discord");
    expect(discordGroup.default).toBeUndefined();
    expect(discordGroup.toolNames).toEqual([
      "discord_message",
      "discord_channel",
      "discord_thread",
      "discord_webhook",
      "discord_server",
    ]);
  });
});

describe("DiscordMessageTool", () => {
  it("routes send to backend.send", async () => {
    const backend = stubBackend();
    const tool = new DiscordMessageTool(backend);
    const r = await tool.run(
      { action: "send", channel_id: "c1", content: "hi" },
      ctx,
    );
    expect(backend.send).toHaveBeenCalledWith("c1", "hi");
    expect(JSON.parse((r as { result: string }).result)).toEqual({ messageId: "m1" });
  });

  it("routes react with channel/message/emoji", async () => {
    const backend = stubBackend();
    const tool = new DiscordMessageTool(backend);
    await tool.run(
      { action: "react", channel_id: "c1", message_id: "m1", emoji: "👍" },
      ctx,
    );
    expect(backend.react).toHaveBeenCalledWith("c1", "m1", "👍");
  });

  it("rejects bulk_delete with empty array", async () => {
    const backend = stubBackend();
    const tool = new DiscordMessageTool(backend);
    await expect(
      tool.run({ action: "bulk_delete", channel_id: "c1", message_ids: [] }, ctx),
    ).rejects.toThrow(/message_ids/);
  });

  it("requires content for send", async () => {
    const backend = stubBackend();
    const tool = new DiscordMessageTool(backend);
    await expect(
      tool.run({ action: "send", channel_id: "c1" }, ctx),
    ).rejects.toThrow(/content is required/);
  });

  it("rejects unknown action", async () => {
    const backend = stubBackend();
    const tool = new DiscordMessageTool(backend);
    await expect(tool.run({ action: "nope" }, ctx)).rejects.toThrow(/unknown action/);
  });
});

describe("DiscordChannelTool", () => {
  it("creates a channel with default text type", async () => {
    const backend = stubBackend();
    const tool = new DiscordChannelTool(backend);
    await tool.run(
      { action: "create", guild_id: "g1", name: "release-notes" },
      ctx,
    );
    expect(backend.createChannel).toHaveBeenCalledWith(
      "g1",
      "release-notes",
      "text",
      {},
    );
  });

  it("validates overwrite_type for edit_permissions", async () => {
    const backend = stubBackend();
    const tool = new DiscordChannelTool(backend);
    await expect(
      tool.run(
        {
          action: "edit_permissions",
          channel_id: "c1",
          overwrite_id: "r1",
          overwrite_type: "bogus" as unknown as "role",
        },
        ctx,
      ),
    ).rejects.toThrow(/overwrite_type/);
  });
});

describe("DiscordThreadTool", () => {
  it("creates a thread off a channel", async () => {
    const backend = stubBackend();
    const tool = new DiscordThreadTool(backend);
    await tool.run(
      { action: "create", channel_id: "c1", name: "release thread" },
      ctx,
    );
    expect(backend.createThread).toHaveBeenCalledWith(
      "c1",
      "release thread",
      undefined,
      undefined,
    );
  });

  it("threads add_member through to the backend", async () => {
    const backend = stubBackend();
    const tool = new DiscordThreadTool(backend);
    await tool.run(
      { action: "add_member", thread_id: "t1", user_id: "u1" },
      ctx,
    );
    expect(backend.addThreadMember).toHaveBeenCalledWith("t1", "u1");
  });
});

describe("DiscordWebhookTool", () => {
  it("posts via webhook with optional username", async () => {
    const backend = stubBackend();
    const tool = new DiscordWebhookTool(backend);
    await tool.run(
      {
        action: "post",
        webhook_id: "w1",
        webhook_token: "tok",
        content: "hello",
        username: "Reporter",
      },
      ctx,
    );
    expect(backend.postWebhook).toHaveBeenCalledWith("w1", "tok", "hello", {
      username: "Reporter",
    });
  });
});

describe("DiscordServerTool", () => {
  it("requires guild_id", async () => {
    const backend = stubBackend();
    const tool = new DiscordServerTool(backend);
    // The schema enforces this, but the tool also defends against it.
    await expect(
      tool.run({ action: "get_guild" } as Record<string, unknown>, ctx),
    ).rejects.toThrow(/guild_id is required/);
  });

  it("fetches a guild", async () => {
    const backend = stubBackend();
    const tool = new DiscordServerTool(backend);
    await tool.run({ action: "get_guild", guild_id: "g1" }, ctx);
    expect(backend.getGuild).toHaveBeenCalledWith("g1");
  });
});
