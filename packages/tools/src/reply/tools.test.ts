import { describe, expect, it } from "vitest";
import { ReplyTool } from "./tools.js";
import type { ReplyArgs, ReplyBackend } from "./backend.js";

function makeBackend(calls: ReplyArgs[]): ReplyBackend {
  return {
    async reply(args) {
      calls.push(args);
      return { messageId: "m1" };
    },
  };
}

describe("ReplyTool", () => {
  it("forwards content + sessionId to the backend and reports success", async () => {
    const calls: ReplyArgs[] = [];
    const tool = new ReplyTool(makeBackend(calls));
    const res = await tool.run(
      { content: "hi there" },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    expect(calls).toEqual([{ sessionId: "s1", content: "hi there" }]);
    expect(JSON.parse(res.result as string)).toMatchObject({ sent: true, messageId: "m1" });
  });

  it("forwards a channel_id override as channelId", async () => {
    const calls: ReplyArgs[] = [];
    const tool = new ReplyTool(makeBackend(calls));
    await tool.run(
      { content: "hi", channel_id: "c9" },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    expect(calls[0]).toMatchObject({ channelId: "c9" });
  });

  it("throws without a sessionId in context", async () => {
    const tool = new ReplyTool(makeBackend([]));
    await expect(tool.run({ content: "hi" }, { cwd: "/tmp" })).rejects.toThrow(/sessionId/);
  });

  it("throws on empty content", async () => {
    const calls: ReplyArgs[] = [];
    const tool = new ReplyTool(makeBackend(calls));
    await expect(
      tool.run({ content: "   " }, { cwd: "/tmp", meta: { sessionId: "s1" } }),
    ).rejects.toThrow(/content/);
    expect(calls).toHaveLength(0);
  });
});
