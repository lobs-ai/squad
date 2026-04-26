import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { ToolRegistry } from "@squad/tools";
import { boot, type BootedGateway } from "../../src/index.js";
import type { Frame, PluginRecord } from "@squad/protocol";

interface Harness {
  ws: WebSocket;
  booted: BootedGateway;
  dataDir: string;
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  next: () => Promise<Frame>;
  send: (frame: unknown) => void;
}

async function bootHarness(extras: { plugins?: Array<string | { path: string; config?: unknown }> } = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-admin-it-"));
  const booted = await boot({
    config: {
      server: {
        host: "127.0.0.1",
        port: 8765,
        data_dir: dataDir,
        memory_dir: join(dataDir, "memory"),
        squad_name: "alpha",
        build: "deadbee",
      },
      auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
      llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
      subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
      policy: {
        approvals: { default: "tag-match", require_for_tags: ["write", "exec"], timeout_seconds: 120 },
      },
      plugins: extras.plugins ?? [],
      channels: {},
    },
    toolRegistry: new ToolRegistry(),
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

  const next = (): Promise<Frame> =>
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

  return { ws, booted, dataDir, request, next, send: (f) => ws.send(JSON.stringify(f)) };
}

describe("admin.identity / admin.peers / extension methods", () => {
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

  it("admin.models surfaces only the configured providers + the primary/fallback even when not in the catalog", async () => {
    // Boot a harness with a custom provider name (`minimax`) and a primary
    // model the catalog doesn't carry. The dashboard / CLI should see
    // exactly that model — not Ollama / LM Studio / Llama leakage.
    const dataDir = mkdtempSync(join(tmpdir(), "squad-models-"));
    let booted: BootedGateway | null = null;
    try {
      booted = await boot({
        config: {
          server: { host: "127.0.0.1", port: 0, data_dir: dataDir, memory_dir: join(dataDir, "memory"), squad_name: "alpha" },
          auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
          llm: {
            primary: { model: "minimax/minimax-m2.7" },
            fallbacks: [{ model: "minimax/minimax-fallback" }],
            providers: { minimax: {} } as Record<string, never>,
          },
          subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
          policy: { approvals: { default: "tag-match", require_for_tags: ["write"], timeout_seconds: 60 } },
          plugins: [],
          channels: {},
        },
        toolRegistry: new (await import("@squad/tools")).ToolRegistry(),
      });
      await new Promise<void>((resolve) => booted!.handle.http.listen(0, "127.0.0.1", resolve));
      const port = (booted.handle.http.address() as AddressInfo).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const id = "models-1";
      const result = new Promise<unknown>((resolve) => {
        ws.on("message", (raw) => {
          const f = JSON.parse(raw.toString()) as Frame;
          if (f.type === "response" && f.id === id && f.ok) resolve(f.result);
        });
      });
      ws.send(JSON.stringify({ type: "request", id, method: "admin.models", params: {} }));
      const { models } = (await result) as { models: Array<{ id: string; provider: string }> };
      ws.close();

      const ids = models.map((m) => m.id);
      expect(ids).toContain("minimax/minimax-m2.7");
      expect(ids).toContain("minimax/minimax-fallback");
      expect(ids.find((i) => i.startsWith("ollama/"))).toBeUndefined();
      expect(ids.find((i) => i.startsWith("anthropic/"))).toBeUndefined();
    } finally {
      await booted?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("admin.identity reflects squad_name and build", async () => {
    harness = await bootHarness();
    const id = await harness.request<{ name: string; build: string; port: number; host: string }>(
      "admin.identity",
      {},
    );
    expect(id.name).toBe("alpha");
    expect(id.build).toBe("deadbee");
    expect(id.port).toBe(8765);
    expect(id.host).toBe("127.0.0.1");
  });

  it("admin.peers returns at least the local squad", async () => {
    harness = await bootHarness();
    const { peers } = await harness.request<{ peers: Array<{ name: string; status: string }> }>(
      "admin.peers",
      {},
    );
    expect(peers.length).toBeGreaterThan(0);
    expect(peers[0]?.status).toBe("healthy");
    expect(peers[0]?.name).toBe("alpha");
  });

  it("approvals.list starts empty and approvals.decide rejects unknown ids", async () => {
    harness = await bootHarness();
    const { approvals } = await harness.request<{ approvals: unknown[] }>("approvals.list", {});
    expect(approvals).toEqual([]);
    await expect(
      harness.request("approvals.decide", { approvalId: "nope", decision: "approve" }),
    ).rejects.toThrow();
  });

  it("plugins.list reflects registered ui contributions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "squad-ui-plugin-"));
    const path = join(tmp, "ui.mjs");
    writeFileSync(
      path,
      `export default {
        id: "ui-queue", name: "Queue monitor", version: "0.1.0", kinds: ["routine"],
        register(api) {
          api.ui.contribute({ slot: "navTab", id: "queue", label: "Queue", icon: "spark" });
          api.ui.contribute({ slot: "overviewWidget", id: "depth", label: "Queue depth" });
        },
      };`,
    );
    try {
      harness = await bootHarness({ plugins: [{ path }] });
      const { plugins } = await harness.request<{ plugins: PluginRecord[] }>("plugins.list", {});
      const rec = plugins.find((p) => p.id === "ui-queue");
      expect(rec).toBeDefined();
      expect(rec!.uiContributions.map((c) => c.slot)).toEqual(["navTab", "overviewWidget"]);
      expect(rec!.uiContributions[0]?.icon).toBe("spark");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("routines.create / list / run_now publishes routines.fired", async () => {
    harness = await bootHarness();
    const { request } = harness;
    const { routine } = await request<{ routine: { id: string } }>("routines.create", {
      name: "ping",
      cron: "* * * * *",
      prompt: "say hi",
      delivery: { kind: "silent" },
      enabled: true,
    });
    const { routines } = await request<{ routines: Array<{ id: string }> }>("routines.list", {});
    expect(routines.find((r) => r.id === routine.id)).toBeDefined();

    // Subscribe to `routines.*/*` so we catch the fired event after run_now.
    await new Promise<void>((resolve) => {
      const id = "sub-1";
      const onMsg = (raw: Buffer): void => {
        const frame = JSON.parse(raw.toString()) as Frame;
        if (frame.type === "response" && frame.id === id) {
          harness!.ws.off("message", onMsg);
          resolve();
        }
      };
      harness!.ws.on("message", onMsg);
      harness!.send({ type: "subscribe", id, topics: ["routines.*/*"] });
    });

    const fired = (async () => {
      while (true) {
        const f = await harness!.next();
        if (f.type === "event" && f.topic.startsWith("routines.fired/")) return f;
      }
    })();
    await request("routines.run_now", { id: routine.id });
    const event = await fired;
    expect(event.type).toBe("event");
  });

  it("channels.list reflects plugin-supplied channels", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "squad-chan-plugin-"));
    const path = join(tmp, "chan.mjs");
    writeFileSync(
      path,
      `export default {
        id: "ch-stub", name: "Stub", version: "0", kinds: ["channel"],
        register(api) {
          api.channels.register({
            id: "stub-channel",
            kind: "discord",
            label: "lobs / squad-dev",
            capabilities: { supportsPreview: true, supportsMultiSelect: true, supportsFreeText: true, maxOptions: 4 },
            start: async () => {},
            stop: async () => {},
          });
        },
      };`,
    );
    try {
      harness = await bootHarness({ plugins: [{ path }] });
      const { channels } = await harness.request<{ channels: Array<{ id: string; kind: string; label: string }> }>(
        "channels.list",
        {},
      );
      const ch = channels.find((c) => c.id === "stub-channel");
      expect(ch?.kind).toBe("discord");
      expect(ch?.label).toBe("lobs / squad-dev");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
