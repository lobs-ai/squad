import { describe, expect, it, vi } from "vitest";
import { CarbonDiscordBackend } from "./backend.js";
import type { BotHandle } from "./bot.js";

type RestStub = {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function makeBackend(rest: RestStub): CarbonDiscordBackend {
  const handle = { client: { rest } } as unknown as BotHandle;
  return new CarbonDiscordBackend(() => handle);
}

function discordError(status: number, discordCode: number, message = "err") {
  // Shape matches @buape/carbon's DiscordError surface that we sniff in
  // looksLikeChannelInaccessible.
  return Object.assign(new Error(message), { status, discordCode });
}

describe("CarbonDiscordBackend.send DM fallback", () => {
  it("retries against an opened DM channel on Missing Access (50001)", async () => {
    const rest: RestStub = {
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    // First /channels/<user>/messages call -> Missing Access.
    // /users/@me/channels         -> returns a DM channel.
    // Retry /channels/<dm>/messages -> success.
    rest.post
      .mockRejectedValueOnce(discordError(403, 50001, "Missing Access"))
      .mockResolvedValueOnce({ id: "dm-1", type: 1 })
      .mockResolvedValueOnce({ id: "msg-1" });

    const backend = makeBackend(rest);
    const r = await backend.send("user-123", "hi");

    expect(r).toEqual({ messageId: "msg-1" });
    expect(rest.post).toHaveBeenNthCalledWith(
      1,
      "/channels/user-123/messages",
      { body: { content: "hi" } },
    );
    expect(rest.post).toHaveBeenNthCalledWith(2, "/users/@me/channels", {
      body: { recipient_id: "user-123" },
    });
    expect(rest.post).toHaveBeenNthCalledWith(
      3,
      "/channels/dm-1/messages",
      { body: { content: "hi" } },
    );
  });

  it("caches the DM channel id across calls for the same user", async () => {
    const rest: RestStub = {
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    rest.post
      .mockRejectedValueOnce(discordError(403, 50001))
      .mockResolvedValueOnce({ id: "dm-1", type: 1 })
      .mockResolvedValueOnce({ id: "msg-1" })
      .mockResolvedValueOnce({ id: "msg-2" });

    const backend = makeBackend(rest);
    await backend.send("user-123", "first");
    await backend.send("dm-1", "second");

    const paths = rest.post.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      "/channels/user-123/messages",
      "/users/@me/channels",
      "/channels/dm-1/messages",
      "/channels/dm-1/messages",
    ]);
  });

  it("propagates the original error when openDm itself fails", async () => {
    const rest: RestStub = {
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const original = discordError(403, 50001, "Missing Access");
    rest.post
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error("openDm failed"));

    const backend = makeBackend(rest);
    await expect(backend.send("user-123", "hi")).rejects.toBe(original);
  });

  it("does not retry when the failure is not access/visibility related", async () => {
    const rest: RestStub = {
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const original = discordError(400, 50035, "Invalid form body");
    rest.post.mockRejectedValueOnce(original);

    const backend = makeBackend(rest);
    await expect(backend.send("c1", "hi")).rejects.toBe(original);
    expect(rest.post).toHaveBeenCalledTimes(1);
  });
});
