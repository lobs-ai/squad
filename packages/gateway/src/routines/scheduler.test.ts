import { describe, it, expect, vi } from "vitest";
import {
  matchesCron,
  computeNextRunAt,
  isDue,
  RoutineScheduler,
} from "./scheduler.js";
import { RoutineStore } from "./store.js";
import { staggerOffsetMs } from "./persistence.js";
import type { RoutineRecord } from "@squad/protocol";

function at(hour: number, minute: number, day = 1, month = 1, dow = 0): Date {
  const d = new Date(2026, month - 1, day, hour, minute, 0, 0);
  void dow;
  return d;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Parameters<typeof RoutineScheduler.prototype.constructor>[2];

describe("matchesCron", () => {
  it("matches wildcards", () => {
    expect(matchesCron("* * * * *", at(9, 0))).toBe(true);
  });
  it("matches an explicit hour + minute", () => {
    expect(matchesCron("15 9 * * *", at(9, 15))).toBe(true);
    expect(matchesCron("15 9 * * *", at(9, 16))).toBe(false);
  });
  it("matches step expressions", () => {
    expect(matchesCron("*/5 * * * *", at(9, 10))).toBe(true);
    expect(matchesCron("*/5 * * * *", at(9, 12))).toBe(false);
  });
  it("rejects bad input", () => {
    expect(matchesCron("wrong", at(9, 0))).toBe(false);
  });
});

describe("computeNextRunAt", () => {
  it("interval anchors at creation when no anchor", () => {
    const ref = new Date("2026-04-30T12:00:00Z");
    const next = computeNextRunAt({ kind: "interval", everyMs: 60_000 }, ref);
    expect(next!.getTime() - ref.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(next!.getTime() - ref.getTime()).toBeLessThan(120_000);
  });

  it("interval with anchor lands on a multiple of everyMs", () => {
    const anchor = new Date("2026-04-30T00:00:00Z").toISOString();
    const ref = new Date("2026-04-30T12:30:30Z");
    const next = computeNextRunAt({ kind: "interval", everyMs: 5 * 60_000, anchor }, ref);
    // The next 5-minute mark after 12:30:30 is 12:35:00.
    expect(next!.toISOString()).toBe("2026-04-30T12:35:00.000Z");
  });

  it("once returns null when in the past", () => {
    const next = computeNextRunAt(
      { kind: "once", at: "2020-01-01T00:00:00Z" },
      new Date(),
    );
    expect(next).toBeNull();
  });

  it("once returns the timestamp when in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const next = computeNextRunAt({ kind: "once", at: future }, new Date());
    expect(next?.toISOString()).toBe(new Date(future).toISOString());
  });

  it("cron finds the next matching minute", () => {
    const ref = new Date(2026, 3, 30, 8, 59, 30);
    const next = computeNextRunAt({ kind: "cron", expr: "0 9 * * *" }, ref);
    expect(next!.getHours()).toBe(9);
    expect(next!.getMinutes()).toBe(0);
  });
});

describe("staggerOffsetMs", () => {
  it("is deterministic for the same seed + jobId", () => {
    const a = staggerOffsetMs("seed", "rt_abc", 60_000);
    const b = staggerOffsetMs("seed", "rt_abc", 60_000);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(60_000);
  });
  it("varies with jobId", () => {
    const a = staggerOffsetMs("seed", "rt_aaa", 60_000);
    const b = staggerOffsetMs("seed", "rt_bbb", 60_000);
    expect(a).not.toBe(b);
  });
});

describe("isDue", () => {
  function makeRec(over: Partial<RoutineRecord> = {}): RoutineRecord {
    return {
      id: "rt_x",
      name: "x",
      enabled: true,
      schedule: { kind: "interval", everyMs: 60_000 },
      payload: { kind: "prompt", text: "p" },
      session: { kind: "new" },
      execution: {},
      delivery: { kind: "silent" },
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      lastError: null,
      consecutiveErrors: 0,
      cron: "",
      prompt: "p",
      model: null,
      ...over,
    };
  }

  it("returns not_due when nextRunAt is in the future", () => {
    const r = makeRec({ nextRunAt: new Date(Date.now() + 60_000).toISOString() });
    expect(isDue(r, new Date(), "seed")).toBe("not_due");
  });

  it("returns fire when within grace window", () => {
    const r = makeRec({ nextRunAt: new Date(Date.now() - 10_000).toISOString() });
    expect(isDue(r, new Date(), "seed")).toBe("fire");
  });

  it("returns skip_stale past grace", () => {
    const r = makeRec({
      schedule: { kind: "interval", everyMs: 60_000 },
      // 10 minutes late, grace is min(30s, 2min) = 2min
      nextRunAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(isDue(r, new Date(), "seed")).toBe("skip_stale");
  });
});

describe("RoutineScheduler advance-before-execute", () => {
  it("rewrites nextRunAt before invoking the runner", async () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "interval",
      enabled: true,
      schedule: { kind: "interval", everyMs: 60_000 },
      payload: { kind: "script", command: "true" },
      session: { kind: "new" },
      delivery: { kind: "silent" },
    });
    // Force this job to be due right now.
    store.setState(r.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });

    const observedNextAtRunTime: Array<string | null> = [];
    const runner = vi.fn(async () => {
      observedNextAtRunTime.push(store.get(r.id)?.nextRunAt ?? null);
      return { sessionId: null, status: "ok" as const };
    });

    const sched = new RoutineScheduler(store, runner, silentLogger, {
      paths: null,
      tickMs: 60_000,
    });
    sched.tickOnce();
    // Wait one microtask cycle so the async fire completes.
    await Promise.resolve();
    await Promise.resolve();

    expect(runner).toHaveBeenCalledTimes(1);
    expect(observedNextAtRunTime[0]).not.toBeNull();
    // The new nextRunAt should be in the future.
    const next = new Date(observedNextAtRunTime[0]!);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it("disables a once-job after firing", async () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "once",
      enabled: true,
      schedule: { kind: "once", at: new Date(Date.now() + 1_000).toISOString() },
      payload: { kind: "script", command: "true" },
      session: { kind: "new" },
      delivery: { kind: "silent" },
    });
    store.setState(r.id, { nextRunAt: new Date(Date.now() - 1_000).toISOString() });

    const runner = vi.fn(async () => ({ sessionId: null, status: "ok" as const }));
    const sched = new RoutineScheduler(store, runner, silentLogger, {
      paths: null,
      tickMs: 60_000,
    });
    sched.tickOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get(r.id)?.enabled).toBe(false);
  });

  it("skips stale jobs without invoking the runner", async () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "stale",
      enabled: true,
      schedule: { kind: "interval", everyMs: 60_000 },
      payload: { kind: "script", command: "true" },
      session: { kind: "new" },
      delivery: { kind: "silent" },
    });
    // 1 hour late on a 1-minute schedule → past grace.
    store.setState(r.id, { nextRunAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    const runner = vi.fn(async () => ({ sessionId: null, status: "ok" as const }));
    const sched = new RoutineScheduler(store, runner, silentLogger, {
      paths: null,
      tickMs: 60_000,
    });
    sched.tickOnce();
    await Promise.resolve();
    expect(runner).not.toHaveBeenCalled();
    expect(store.get(r.id)?.lastStatus).toBe("skipped");
  });
});
