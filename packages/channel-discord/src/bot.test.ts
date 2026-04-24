import { describe, it, expect } from "vitest";
import { shouldRespond } from "./bot.js";
import type { DiscordConfig } from "./config.js";

/**
 * Shape of the bits of discord.js's `Message` that `shouldRespond` reads.
 * Typing only what we use lets us build tiny fixtures without mocking the
 * whole Discord client.
 */
type MessageLike = {
  guildId: string | null;
  channelId: string;
  author: { id: string };
  mentions: { users: { has: (id: string) => boolean } };
};

function mkMessage(overrides: Partial<MessageLike>): MessageLike {
  return {
    guildId: null,
    channelId: "c",
    author: { id: "user-1" },
    mentions: { users: { has: () => false } },
    ...overrides,
  };
}

function mkConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    bot_token_env: "DISCORD_BOT_TOKEN",
    gateway_url: "ws://127.0.0.1:8080/ws",
    bindings: [],
    dm_policy: "allow_list",
    dm_allow_list: [],
    approval_tags: ["write", "exec", "network"],
    max_message_length: 1900,
    stream_edits: true,
    ...overrides,
  };
}

describe("shouldRespond DM policy", () => {
  it("allow_list: answers users on the list", () => {
    const cfg = mkConfig({ dm_policy: "allow_list", dm_allow_list: ["user-1"] });
    expect(shouldRespond(mkMessage({}), cfg, "bot-id")).toBe(true);
  });

  it("allow_list: ignores users not on the list", () => {
    const cfg = mkConfig({ dm_policy: "allow_list", dm_allow_list: ["other"] });
    expect(shouldRespond(mkMessage({}), cfg, "bot-id")).toBe(false);
  });

  it("allow_list: empty list means no DMs are answered (safe default)", () => {
    expect(shouldRespond(mkMessage({}), mkConfig(), "bot-id")).toBe(false);
  });

  it("open: answers DMs from anyone", () => {
    const cfg = mkConfig({ dm_policy: "open" });
    expect(shouldRespond(mkMessage({}), cfg, "bot-id")).toBe(true);
    expect(
      shouldRespond(mkMessage({ author: { id: "random" } }), cfg, "bot-id"),
    ).toBe(true);
  });

  it("blocked: refuses every DM regardless of the allow-list", () => {
    const cfg = mkConfig({
      dm_policy: "blocked",
      dm_allow_list: ["user-1"],
    });
    expect(shouldRespond(mkMessage({}), cfg, "bot-id")).toBe(false);
  });

  it("DM policy does not affect guild channels", () => {
    // In a guild: bindings + mentions rule. An "allow_list" DM policy must
    // not retroactively block guild messages from users outside it.
    const cfg = mkConfig({
      dm_policy: "allow_list",
      dm_allow_list: [],
      bindings: [{ guild_id: "g1", channel_id: "c1" }],
    });
    const bound = mkMessage({
      guildId: "g1",
      channelId: "c1",
      author: { id: "outsider" },
    });
    expect(shouldRespond(bound, cfg, "bot-id")).toBe(true);
  });

  it("guild: unbound channel with no mention is ignored", () => {
    const cfg = mkConfig({ bindings: [{ guild_id: "g1", channel_id: "c1" }] });
    const other = mkMessage({ guildId: "g1", channelId: "c2" });
    expect(shouldRespond(other, cfg, "bot-id")).toBe(false);
  });

  it("guild: @mention is enough to respond even without a binding", () => {
    const cfg = mkConfig({ bindings: [] });
    const mentioned = mkMessage({
      guildId: "g1",
      channelId: "c-any",
      mentions: { users: { has: (id) => id === "bot-id" } },
    });
    expect(shouldRespond(mentioned, cfg, "bot-id")).toBe(true);
  });
});
