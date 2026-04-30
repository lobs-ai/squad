import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { ToolRegistry } from "@squad/tools";
import { boot, type BootedGateway } from "../../src/index.js";
import { StubMemCore } from "../fixtures/stub-memcore.js";
import type { MemCore } from "memcore";
import type { Frame, PairingView } from "@squad/protocol";

interface Harness {
  ws: WebSocket;
  port: number;
  booted: BootedGateway;
  dataDir: string;
  request: <T = unknown>(method: string, params: unknown) => Promise<T>;
  http: (path: string, init?: RequestInit) => Promise<Response>;
}

async function bootHarness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-pair-"));
  const booted = await boot({
    memcoreOverride: new StubMemCore() as unknown as MemCore,
    config: {
      server: { host: "127.0.0.1", port: 0, data_dir: dataDir, squad_name: "alpha" },
      auth: { tokens: [{ label: "admin", key: "secret", scopes: ["*"] }] },
      llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
      subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
      policy: { approvals: { default: "tag-match", require_for_tags: ["write"], timeout_seconds: 60 } },
      plugins: [],
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
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    if (frame.type === "response" && pending.has(frame.id)) {
      pending.get(frame.id)!(frame);
      pending.delete(frame.id);
    }
  });
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

  const http = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${address.port}${path}`, init);

  return { ws, port: address.port, booted, dataDir, request, http };
}

describe("browser pairing", () => {
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

  it("end-to-end: browser begins, CLI approves, browser polls + uses the token", async () => {
    harness = await bootHarness();
    const { request, http, port } = harness;

    // 1. Browser starts a pairing — no auth.
    const beginRes = await http("/pair/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Rafe's MacBook" }),
    });
    expect(beginRes.status).toBe(200);
    const { pairing } = (await beginRes.json()) as { pairing: PairingView };
    expect(pairing.code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(pairing.status).toBe("pending");

    // 2. Browser polls — still pending.
    const pollPending = await (await http(`/pair/poll?code=${pairing.code}`)).json();
    expect(pollPending).toMatchObject({ status: "pending" });

    // 3. CLI approves over the authenticated WS.
    const { pairing: approved } = await request<{ pairing: PairingView }>("admin.pair.approve", {
      code: pairing.code,
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("admin");

    // 4. Browser polls again — gets the token + label.
    const pollApproved = (await (await http(`/pair/poll?code=${pairing.code}`)).json()) as {
      status: string;
      token?: string;
      label?: string;
    };
    expect(pollApproved.status).toBe("approved");
    expect(typeof pollApproved.token).toBe("string");
    expect(pollApproved.label).toBe("Rafe's MacBook");

    // 5. Subsequent polls don't leak the token a second time.
    const pollOnce = (await (await http(`/pair/poll?code=${pairing.code}`)).json()) as {
      status: string;
      token?: string;
    };
    expect(pollOnce.status).toBe("claimed");
    expect(pollOnce.token).toBeUndefined();

    // 6. The minted token works against /ws.
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${pollApproved.token}`);
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", () => resolve());
      browserWs.once("error", reject);
    });
    browserWs.close();
  });

  it("admin.pair.list shows pending pairings; cancel removes them", async () => {
    harness = await bootHarness();
    const { request, http } = harness;
    const begin = (await (await http("/pair/begin", { method: "POST" })).json()) as {
      pairing: PairingView;
    };
    const { pairings } = await request<{ pairings: PairingView[] }>("admin.pair.list", {});
    expect(pairings.find((p) => p.code === begin.pairing.code)).toBeDefined();
    await request("admin.pair.cancel", { code: begin.pairing.code });
    const after = await request<{ pairings: PairingView[] }>("admin.pair.list", {});
    expect(after.pairings.find((p) => p.code === begin.pairing.code)?.status).toBe("cancelled");
    const claim = (await (await http(`/pair/poll?code=${begin.pairing.code}`)).json()) as {
      status: string;
    };
    expect(claim.status).toBe("cancelled");
  });

  it("rejects unknown codes with a clear error", async () => {
    harness = await bootHarness();
    await expect(harness.request("admin.pair.approve", { code: "NOPE-NOPE" })).rejects.toThrow(
      /unknown pairing/,
    );
  });

  it("a paired browser keeps working across a gateway restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "squad-pair-restart-"));
    let booted: BootedGateway | null = null;
    try {
      // ── boot 1: pair a browser, capture its token ─────────────────────
      const boot1 = await boot({
        memcoreOverride: new StubMemCore() as unknown as MemCore,
        config: {
          server: { host: "127.0.0.1", port: 0, data_dir: dataDir, squad_name: "alpha" },
          auth: { tokens: [{ label: "admin", key: "secret", scopes: ["*"] }] },
          llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
          subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
          policy: { approvals: { default: "tag-match", require_for_tags: ["write"], timeout_seconds: 60 } },
          plugins: [],
          channels: {},
        },
        toolRegistry: new ToolRegistry(),
      });
      booted = boot1;
      await new Promise<void>((resolve) => boot1.handle.http.listen(0, "127.0.0.1", resolve));
      const port1 = (boot1.handle.http.address() as AddressInfo).port;

      const begin = (await (
        await fetch(`http://127.0.0.1:${port1}/pair/begin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "Persistent Browser" }),
        })
      ).json()) as { pairing: PairingView };

      // CLI approves over WS.
      const ws = new WebSocket(`ws://127.0.0.1:${port1}/ws?token=secret`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const id = "approve-1";
      const approved = new Promise<void>((resolve) => {
        ws.on("message", (raw) => {
          const f = JSON.parse(raw.toString()) as Frame;
          if (f.type === "response" && f.id === id) resolve();
        });
      });
      ws.send(JSON.stringify({ type: "request", id, method: "admin.pair.approve", params: { code: begin.pairing.code } }));
      await approved;
      ws.close();

      const claim = (await (
        await fetch(`http://127.0.0.1:${port1}/pair/poll?code=${begin.pairing.code}`)
      ).json()) as { token?: string };
      expect(claim.token).toBeDefined();
      const browserToken = claim.token!;

      await boot1.close();

      // ── boot 2: reuse the same data_dir and try the saved token ─────
      const boot2 = await boot({
        memcoreOverride: new StubMemCore() as unknown as MemCore,
        config: {
          server: { host: "127.0.0.1", port: 0, data_dir: dataDir, squad_name: "alpha" },
          auth: { tokens: [{ label: "admin", key: "secret", scopes: ["*"] }] },
          llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
          subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
          policy: { approvals: { default: "tag-match", require_for_tags: ["write"], timeout_seconds: 60 } },
          plugins: [],
          channels: {},
        },
        toolRegistry: new ToolRegistry(),
      });
      booted = boot2;
      await new Promise<void>((resolve) => boot2.handle.http.listen(0, "127.0.0.1", resolve));
      const port2 = (boot2.handle.http.address() as AddressInfo).port;

      // The previously-paired browser reconnects with its saved token.
      const ws2 = new WebSocket(`ws://127.0.0.1:${port2}/ws?token=${browserToken}`);
      await new Promise<void>((resolve, reject) => {
        ws2.once("open", () => resolve());
        ws2.once("error", reject);
      });
      ws2.close();
      await boot2.close();
      booted = null;
    } finally {
      await booted?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
