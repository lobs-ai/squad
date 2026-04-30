import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { LLMClient, LLMResponse, CreateMessageParams } from "@squad/llm";
import { ToolRegistry } from "@squad/tools";
import {
  boot,
  type BootedGateway,
} from "../../src/index.js";
import { StubMemCore } from "../fixtures/stub-memcore.js";
import type { MemCore } from "memcore";
import type { Frame } from "@squad/protocol";

class ScriptedClient implements LLMClient {
  constructor(private readonly replies: string[]) {}
  async createMessage(_params: CreateMessageParams): Promise<LLMResponse> {
    const text = this.replies.shift() ?? "ok";
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
  async streamMessage(
    _params: CreateMessageParams,
    onChunk: (t: string) => void,
  ): Promise<LLMResponse> {
    const text = this.replies.shift() ?? "ok";
    for (const word of text.split(" ")) onChunk(word + " ");
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

interface Harness {
  ws: WebSocket;
  port: number;
  booted: BootedGateway;
  dataDir: string;
  nextFrame: () => Promise<Frame>;
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
}

async function bootHarness(replies: string[]): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-it-"));
  const booted = await boot({
    memcoreOverride: new StubMemCore() as unknown as MemCore,
    config: {
      server: { host: "127.0.0.1", port: 0, data_dir: dataDir },
      auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
      llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
      subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
      policy: {
        approvals: {
          default: "tag-match",
          require_for_tags: ["write", "exec", "network"],
          timeout_seconds: 120,
        },
      },
      plugins: [],
      channels: {},
    },
    toolRegistry: new ToolRegistry(),
    clientOverride: new ScriptedClient(replies),
  });
  await new Promise<void>((resolve) => booted.handle.http.listen(0, "127.0.0.1", resolve));
  const address = booted.handle.http.address() as AddressInfo;

  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=secret`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const pending = new Map<string, (frame: Frame) => void>();
  const queue: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];

  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    if (frame.type === "response" && pending.has(frame.id)) {
      pending.get(frame.id)!(frame);
      pending.delete(frame.id);
      return;
    }
    if (waiters.length > 0) waiters.shift()!(frame);
    else queue.push(frame);
  });

  const nextFrame = (): Promise<Frame> =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve) => waiters.push(resolve));

  const request = async <T = unknown>(method: string, params: unknown): Promise<T> => {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    const done = new Promise<Frame>((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ type: "request", id, method, params }));
    const frame = await done;
    if (frame.type !== "response" || !frame.ok) {
      throw new Error(
        `request ${method} failed: ${frame.type === "response" && !frame.ok ? frame.error.message : "unexpected frame"}`,
      );
    }
    return frame.result as T;
  };

  return { ws, port: address.port, booted, dataDir, nextFrame, request };
}

describe("gateway chat roundtrip", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(async () => {
    if (harness) {
      harness.ws.close();
      await harness.booted.close();
      rmSync(harness.dataDir, { recursive: true, force: true });
    }
  });

  it("starts a session, sends a message, and streams deltas", async () => {
    harness = await bootHarness(["hello from the test"]);
    const { request, nextFrame } = harness;

    const { session } = await request<{ session: { id: string } }>("session.start", {
      title: "roundtrip",
    });

    // `subscribe` is its own frame type, not a dispatcher method.
    await new Promise<void>((resolve) => {
      const id = "sub-1";
      const ws = harness!.ws;
      const onMsg = (raw: Buffer): void => {
        const frame = JSON.parse(raw.toString()) as Frame;
        if (frame.type === "response" && frame.id === id) {
          ws.off("message", onMsg);
          resolve();
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ type: "subscribe", id, topics: [`chat.*/${session.id}`] }));
    });

    const sendPromise = request("chat.send", {
      sessionId: session.id,
      content: "hi",
    });

    // Expect a user_message event, then one or more text_delta events, then an assistant_message.
    const events: Array<{ topic: string; data: unknown }> = [];
    while (events.filter((e) => e.topic.startsWith("chat.assistant_message")).length === 0) {
      const frame = await nextFrame();
      if (frame.type === "event") events.push({ topic: frame.topic, data: frame.data });
    }
    await sendPromise;

    const topics = events.map((e) => e.topic.split("/")[0]);
    expect(topics).toContain("chat.user_message");
    expect(topics).toContain("chat.text_delta");
    expect(topics).toContain("chat.assistant_message");

    const assistant = events.find((e) => e.topic.startsWith("chat.assistant_message"))!.data as {
      message: { content: Array<{ type: string; text: string }> };
    };
    const text = assistant.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("hello from the test");
  }, 20000);

  it("session.rename / setModel / stats / compact round-trip over the wire", async () => {
    harness = await bootHarness(["reply"]);
    const { request } = harness;

    const { session } = await request<{ session: { id: string; model: string; title: string | null } }>(
      "session.start",
      { title: "original" },
    );
    expect(session.title).toBe("original");

    // rename
    const renamed = await request<{ session: { title: string } }>("session.rename", {
      sessionId: session.id,
      title: "renamed",
    });
    expect(renamed.session.title).toBe("renamed");

    // setModel — provider list is empty so any id is accepted
    const switched = await request<{ session: { model: string; fallbacks: string[] } }>(
      "session.setModel",
      { sessionId: session.id, model: "new-model", fallbacks: ["fb1", "fb2"] },
    );
    expect(switched.session.model).toBe("new-model");
    expect(switched.session.fallbacks).toEqual(["fb1", "fb2"]);

    // stats before any chat
    const stats = await request<{
      messageCount: number;
      estimatedTokens: number;
    }>("session.stats", { sessionId: session.id });
    expect(stats.messageCount).toBe(0);
    expect(stats.estimatedTokens).toBe(0);

    // compact — should arm the flag even with no history
    const compacted = await request<{
      queued: boolean;
      beforeMessageCount: number;
    }>("session.compact", { sessionId: session.id });
    expect(compacted.queued).toBe(true);
    expect(compacted.beforeMessageCount).toBe(0);
  }, 20000);
});
