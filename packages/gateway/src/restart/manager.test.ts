import { describe, it, expect, vi } from "vitest";
import {
  RestartManager,
  RestartUnsupportedError,
  SQUAD_RESTART_EXIT_CODE,
  detectRespawnGuarantee,
} from "./manager.js";
import { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";

function silentLogger(): Logger {
  const noop = () => {
    /* swallow */
  };
  // RestartManager only calls a handful of methods.
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    trace: noop,
    child: () => silentLogger(),
  } as unknown as Logger;
}

interface Harness {
  broadcast: Broadcast;
  manager: RestartManager;
  closeCalls: number;
  exitCalls: number[];
  scheduledTimers: Array<{ cb: () => void; ms: number }>;
  fireTimer: (idx?: number) => void;
}

function harness(opts?: {
  env?: NodeJS.ProcessEnv;
  closeImpl?: () => Promise<void>;
}): Harness {
  const broadcast = new Broadcast();
  let closeCalls = 0;
  const exitCalls: number[] = [];
  const scheduledTimers: Array<{ cb: () => void; ms: number }> = [];
  const manager = new RestartManager({
    logger: silentLogger(),
    broadcast,
    close: async () => {
      closeCalls += 1;
      if (opts?.closeImpl) await opts.closeImpl();
    },
    exit: (code) => {
      exitCalls.push(code);
    },
    setTimer: (cb, ms) => {
      scheduledTimers.push({ cb, ms });
      return undefined;
    },
    env: opts?.env ?? { SQUAD_SUPERVISED: "1" },
    delayMs: 100,
  });
  return {
    broadcast,
    manager,
    get closeCalls() {
      return closeCalls;
    },
    get exitCalls() {
      return exitCalls;
    },
    scheduledTimers,
    fireTimer(idx = 0) {
      scheduledTimers[idx]?.cb();
    },
  };
}

describe("detectRespawnGuarantee", () => {
  it("returns null when SQUAD_SUPERVISED=1", () => {
    expect(detectRespawnGuarantee({ SQUAD_SUPERVISED: "1" })).toBeNull();
  });

  it("returns null when SQUAD_RESTART_POLICY is set to any non-empty value", () => {
    expect(detectRespawnGuarantee({ SQUAD_RESTART_POLICY: "docker" })).toBeNull();
    expect(detectRespawnGuarantee({ SQUAD_RESTART_POLICY: "systemd" })).toBeNull();
  });

  it("returns an explanation when neither signal is present", () => {
    const reason = detectRespawnGuarantee({});
    expect(reason).toBeTypeOf("string");
    expect(reason).toMatch(/no respawn guarantee/);
  });

  it("rejects an empty SQUAD_RESTART_POLICY", () => {
    expect(detectRespawnGuarantee({ SQUAD_RESTART_POLICY: "" })).not.toBeNull();
    expect(detectRespawnGuarantee({ SQUAD_RESTART_POLICY: "   " })).not.toBeNull();
  });
});

describe("RestartManager", () => {
  it("refuses to schedule a restart when the runtime can't guarantee a respawn", async () => {
    const h = harness({ env: {} });
    await expect(h.manager.requestRestart({ reason: "test" })).rejects.toBeInstanceOf(
      RestartUnsupportedError,
    );
    expect(h.scheduledTimers).toHaveLength(0);
    expect(h.exitCalls).toEqual([]);
  });

  it("schedules a restart when supervised and broadcasts gateway.restarting", async () => {
    const h = harness();
    const events: Array<{ topic: string; data: unknown }> = [];
    h.broadcast.subscribe(
      { id: "t", send: (f) => events.push({ topic: f.topic, data: f.data }) },
      "gateway.restarting",
    );

    const result = await h.manager.requestRestart({ reason: "config change" });
    expect(result).toMatchObject({ scheduled: true, reason: "config change" });
    expect(h.scheduledTimers).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ reason: "config change" });
  });

  it("only closes + exits once the timer fires", async () => {
    const h = harness();
    await h.manager.requestRestart({ reason: "later" });
    expect(h.closeCalls).toBe(0);
    expect(h.exitCalls).toEqual([]);

    h.fireTimer();
    // close is async; flush the microtask queue.
    await new Promise((r) => setImmediate(r));
    expect(h.closeCalls).toBe(1);
    expect(h.exitCalls).toEqual([SQUAD_RESTART_EXIT_CODE]);
  });

  it("still exits with code 75 if close() throws", async () => {
    const h = harness({
      closeImpl: async () => {
        throw new Error("boom");
      },
    });
    await h.manager.requestRestart({ reason: "test" });
    h.fireTimer();
    await new Promise((r) => setImmediate(r));
    expect(h.exitCalls).toEqual([SQUAD_RESTART_EXIT_CODE]);
  });

  it("is idempotent: a second request coalesces with the first", async () => {
    const h = harness();
    const first = await h.manager.requestRestart({ reason: "first" });
    const second = await h.manager.requestRestart({ reason: "second" });
    expect(second).toEqual(first);
    expect(h.scheduledTimers).toHaveLength(1);
  });
});
