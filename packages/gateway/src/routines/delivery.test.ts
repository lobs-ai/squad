import { describe, it, expect, vi } from "vitest";
import { Broadcast } from "../broadcast.js";
import { DeliveryRegistry } from "./delivery.js";
import type { Logger } from "../logger.js";

function fakeLogger(): Logger {
  const fn = vi.fn();
  return { info: fn, warn: fn, error: fn, debug: fn, trace: fn, fatal: fn } as unknown as Logger;
}

describe("DeliveryRegistry", () => {
  it("ships with built-in silent and dashboard kinds", () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    expect(r.kinds().sort()).toEqual(["dashboard", "silent"]);
  });

  it("dispatches to a registered handler when the kind matches", async () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    const handler = vi.fn().mockResolvedValue({ ok: true });
    r.register("discord", handler);
    const result = await r.dispatch({
      routineId: "rt_1",
      routineName: "rt",
      delivery: { kind: "discord", channelId: "c1" },
      runId: "run-1",
      sessionId: "s_1",
      payloadKind: "prompt",
      output: "hi",
      silentGate: false,
    });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns ok for silent without invoking any handler", async () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    const result = await r.dispatch({
      routineId: "rt_1",
      routineName: "rt",
      delivery: { kind: "silent" },
      runId: "run-1",
      sessionId: null,
      payloadKind: "script",
      silentGate: false,
    });
    expect(result.ok).toBe(true);
  });

  it("short-circuits when the silentGate is set", async () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    const handler = vi.fn();
    r.register("discord", handler);
    const result = await r.dispatch({
      routineId: "rt_1",
      routineName: "rt",
      delivery: { kind: "discord", channelId: "c1" },
      runId: "run-1",
      sessionId: "s_1",
      payloadKind: "prompt",
      output: "[SILENT] secret",
      silentGate: true,
    });
    expect(result.ok).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns an error envelope when no handler is registered for the kind", async () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    const result = await r.dispatch({
      routineId: "rt_1",
      routineName: "rt",
      delivery: { kind: "webhook", url: "https://example.com" } as { kind: string } & Record<string, unknown>,
      runId: "run-1",
      sessionId: null,
      payloadKind: "prompt",
      silentGate: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/webhook/);
  });

  it("dispatches plugin-registered kinds (slack) with their extras forwarded", async () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    const handler = vi.fn().mockResolvedValue({ ok: true });
    r.register("slack", handler);
    const result = await r.dispatch({
      routineId: "rt_1",
      routineName: "alerts",
      delivery: {
        kind: "slack",
        channel: "#alerts",
        emoji: ":robot_face:",
      } as { kind: string } & Record<string, unknown>,
      runId: "run-1",
      sessionId: "s_1",
      payloadKind: "prompt",
      output: "found 3 errors",
      silentGate: false,
    });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0]![0] as {
      delivery: { kind: string; channel?: string; emoji?: string };
    };
    expect(ctx.delivery.kind).toBe("slack");
    expect(ctx.delivery.channel).toBe("#alerts");
    expect(ctx.delivery.emoji).toBe(":robot_face:");
  });

  it("captures handler exceptions into the error envelope", async () => {
    const r = new DeliveryRegistry(new Broadcast(), fakeLogger());
    r.register("discord", async () => {
      throw new Error("post failed");
    });
    const result = await r.dispatch({
      routineId: "rt_1",
      routineName: "rt",
      delivery: { kind: "discord", channelId: "c1" },
      runId: "run-1",
      sessionId: null,
      payloadKind: "prompt",
      silentGate: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("post failed");
  });
});
