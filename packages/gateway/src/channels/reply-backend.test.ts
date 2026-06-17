import { describe, expect, it } from "vitest";
import type { ChannelSendTarget } from "@squad/plugin-sdk";
import { replyBackendFor } from "./reply-backend.js";
import { ChannelRegistry } from "./registry.js";
import type { SessionStore } from "../db/sessions.js";

type FakeSession = { id: string; platform: string | null; remoteId: string | null };

function sessionsStub(rec: FakeSession | null): SessionStore {
  return {
    tryGet: (id: string) => (rec && id === rec.id ? rec : null),
  } as unknown as SessionStore;
}

function discordRegistry(
  sent: Array<{ target: ChannelSendTarget; content: string }>,
): ChannelRegistry {
  const channels = new ChannelRegistry();
  channels.add({
    id: "discord",
    kind: "discord",
    label: "Discord",
    start: async () => {},
    stop: async () => {},
    send: async (target, content) => {
      sent.push({ target, content });
      return { messageId: "m1" };
    },
  });
  return channels;
}

describe("replyBackendFor", () => {
  it("dispatches to the channel sender for the session's platform", async () => {
    const sent: Array<{ target: ChannelSendTarget; content: string }> = [];
    const backend = replyBackendFor({
      sessions: sessionsStub({ id: "s1", platform: "discord", remoteId: "g:c:u" }),
      channels: discordRegistry(sent),
    });
    const res = await backend.reply({ sessionId: "s1", content: "hello" });
    expect(res).toEqual({ messageId: "m1" });
    expect(sent).toEqual([{ target: { remoteId: "g:c:u" }, content: "hello" }]);
  });

  it("passes a channelId override through to the sender", async () => {
    const sent: Array<{ target: ChannelSendTarget; content: string }> = [];
    const backend = replyBackendFor({
      sessions: sessionsStub({ id: "s1", platform: "discord", remoteId: "g:c:u" }),
      channels: discordRegistry(sent),
    });
    await backend.reply({ sessionId: "s1", content: "x", channelId: "c9" });
    expect(sent[0]!.target).toEqual({ remoteId: "g:c:u", channelId: "c9" });
  });

  it("errors when the session is not attached to a channel", async () => {
    const backend = replyBackendFor({
      sessions: sessionsStub({ id: "s1", platform: null, remoteId: null }),
      channels: new ChannelRegistry(),
    });
    await expect(backend.reply({ sessionId: "s1", content: "x" })).rejects.toThrow(
      /nowhere to send/,
    );
  });

  it("errors when no channel of that platform is registered", async () => {
    const backend = replyBackendFor({
      sessions: sessionsStub({ id: "s1", platform: "discord", remoteId: "g:c:u" }),
      channels: new ChannelRegistry(),
    });
    await expect(backend.reply({ sessionId: "s1", content: "x" })).rejects.toThrow(
      /no connected "discord"/,
    );
  });

  it("errors when the session is missing", async () => {
    const backend = replyBackendFor({
      sessions: sessionsStub(null),
      channels: new ChannelRegistry(),
    });
    await expect(backend.reply({ sessionId: "nope", content: "x" })).rejects.toThrow(
      /not found/,
    );
  });
});
