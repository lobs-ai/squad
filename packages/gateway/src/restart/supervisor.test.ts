import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { runSupervisor } from "./supervisor.js";
import { SQUAD_RESTART_EXIT_CODE } from "./manager.js";

interface FakeChild extends ChildProcess {
  /** Test-only: simulate the child exiting. */
  fakeExit(code: number | null, signal?: NodeJS.Signals | null): void;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as unknown as FakeChild;
  let killed = false;
  // Minimal ChildProcess shape — supervisor only touches `kill`, `killed`, `once("exit")`.
  Object.defineProperty(ee, "killed", { get: () => killed });
  ee.kill = ((_sig?: NodeJS.Signals) => {
    killed = true;
    return true;
  }) as ChildProcess["kill"];
  ee.fakeExit = (code, signal = null) => {
    (ee as unknown as EventEmitter).emit("exit", code, signal);
  };
  return ee;
}

interface Harness {
  spawned: FakeChild[];
  exitCodes: number[];
  /** Resolves once runSupervisor returns. */
  done: Promise<void>;
}

function startSupervisor(opts: {
  // What to do for each successive spawn call: returns a fake child + how it'll exit.
  exitPlan: Array<{ code: number | null; signal?: NodeJS.Signals | null }>;
}): Harness {
  const spawned: FakeChild[] = [];
  const exitCodes: number[] = [];
  let spawnIdx = 0;
  const done = runSupervisor({
    entry: "/fake/bin.js",
    args: [],
    execPath: "/fake/node",
    env: {},
    sleep: async () => {
      /* skip backoff for tests */
    },
    onSignal: () => {
      /* don't subscribe to real process signals */
    },
    spawnFn: ((_exec: string, _argv: readonly string[]) => {
      const child = makeFakeChild();
      spawned.push(child);
      // Schedule the corresponding exit on next tick so the supervisor can
      // attach its `once("exit")` listener first.
      const plan = opts.exitPlan[spawnIdx++];
      setImmediate(() => {
        child.fakeExit(plan?.code ?? 0, plan?.signal ?? null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
    exit: (code) => {
      exitCodes.push(code);
    },
  });
  return { spawned, exitCodes, done };
}

describe("runSupervisor", () => {
  it("respawns on SQUAD_RESTART_EXIT_CODE and exits cleanly when the child exits 0", async () => {
    const h = startSupervisor({
      exitPlan: [
        { code: SQUAD_RESTART_EXIT_CODE },
        { code: SQUAD_RESTART_EXIT_CODE },
        { code: 0 },
      ],
    });
    await h.done;
    expect(h.spawned).toHaveLength(3);
    expect(h.exitCodes).toEqual([0]);
  });

  it("propagates a non-restart exit code without respawning", async () => {
    const h = startSupervisor({ exitPlan: [{ code: 42 }] });
    await h.done;
    expect(h.spawned).toHaveLength(1);
    expect(h.exitCodes).toEqual([42]);
  });

  it("propagates a signal-death as 128 + signum", async () => {
    const h = startSupervisor({
      exitPlan: [{ code: null, signal: "SIGTERM" }],
    });
    await h.done;
    expect(h.exitCodes).toEqual([128 + 15]);
  });

  it("gives up after too many rapid restarts", async () => {
    const h = startSupervisor({
      exitPlan: Array.from({ length: 10 }, () => ({ code: SQUAD_RESTART_EXIT_CODE })),
    });
    await h.done;
    // 5 allowed restarts → on the 6th, the loop guard fires.
    expect(h.spawned.length).toBeGreaterThan(5);
    expect(h.spawned.length).toBeLessThanOrEqual(7);
    expect(h.exitCodes).toEqual([1]);
  });
});
