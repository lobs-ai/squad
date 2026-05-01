import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineStore } from "./store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "squad-cron-store-"));
}

describe("RoutineStore (in-memory)", () => {
  it("legacy create / list / update / delete round-trip", () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "nightly",
      cron: "0 3 * * *",
      prompt: "summarize",
      delivery: { kind: "dashboard" },
      enabled: true,
    });
    expect(store.list()).toHaveLength(1);
    expect(store.get(r.id)?.name).toBe("nightly");
    // Legacy mirrors are populated for back-compat.
    expect(r.cron).toBe("0 3 * * *");
    expect(r.prompt).toBe("summarize");
    expect(r.schedule.kind).toBe("cron");
    expect(r.payload.kind).toBe("prompt");
    expect(r.session.kind).toBe("new");

    const updated = store.update({ id: r.id, name: "renamed", enabled: false });
    expect(updated?.name).toBe("renamed");
    expect(updated?.enabled).toBe(false);

    expect(store.delete(r.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.delete("never")).toBe(false);
  });

  it("structured create round-trips with all fields", () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "every-30",
      enabled: true,
      schedule: { kind: "interval", everyMs: 30 * 60_000 },
      payload: {
        kind: "prompt",
        messages: [{ role: "user", text: "tick" }],
        skills: ["weather"],
      },
      session: { kind: "isolated" },
      execution: { model: "claude-haiku-4-5", fallbacks: ["claude-sonnet-4-5"] },
      delivery: { kind: "silent" },
    });
    expect(r.schedule).toEqual({ kind: "interval", everyMs: 1_800_000 });
    expect(r.session).toEqual({ kind: "isolated" });
    expect(r.execution.model).toBe("claude-haiku-4-5");
    expect(r.model).toBe("claude-haiku-4-5"); // legacy mirror
    expect(r.cron).toBe(""); // not a cron schedule
  });

  it("custom delivery kind round-trips with its extra fields", () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "alerts",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *" },
      payload: {
        kind: "prompt",
        messages: [{ role: "user", text: "scan logs" }],
      },
      session: { kind: "new" },
      delivery: { kind: "slack", channel: "#alerts", emoji: ":robot_face:" } as {
        kind: string;
      } & Record<string, unknown>,
    });
    expect(r.delivery.kind).toBe("slack");
    expect((r.delivery as { channel?: string }).channel).toBe("#alerts");
    expect((r.delivery as { emoji?: string }).emoji).toBe(":robot_face:");
  });

  it("script payload + new session target", () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "ping",
      enabled: true,
      schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
      payload: { kind: "script", command: "echo", args: ["hi"] },
      session: { kind: "new" },
      delivery: { kind: "silent" },
    });
    expect(r.payload.kind).toBe("script");
    expect(r.prompt).toBe(""); // not a prompt payload
  });

  it("adoptFromPlugin is idempotent on name (legacy descriptor)", () => {
    const store = new RoutineStore();
    const r1 = store.adoptFromPlugin({ name: "x", cron: "* * * * *", prompt: "p" });
    const r2 = store.adoptFromPlugin({ name: "x", cron: "* * * * *", prompt: "p" });
    expect(r1.id).toBe(r2.id);
    expect(store.list()).toHaveLength(1);
  });

  it("adoptFromPlugin handles structured descriptor", () => {
    const store = new RoutineStore();
    const r = store.adoptFromPlugin({
      name: "structured",
      cron: "* * * * *",
      prompt: "ignored",
      schedule: { kind: "interval", everyMs: 60_000 },
      payload: { kind: "script", command: "true" },
      session: { kind: "isolated" },
    });
    expect(r.schedule.kind).toBe("interval");
    expect(r.payload.kind).toBe("script");
    expect(r.session.kind).toBe("isolated");
  });

  it("runNow invokes the runner, marks fired, emits onFired", async () => {
    const onFired = vi.fn();
    const store = new RoutineStore({ onFired });
    const r = store.create({
      name: "now",
      cron: "* * * * *",
      prompt: "ping",
      delivery: { kind: "silent" },
      enabled: true,
    });
    const result = await store.runNow(r.id, async () => ({ sessionId: "ses-7" }));
    expect(result.sessionId).toBe("ses-7");
    expect(store.get(r.id)?.lastRunAt).not.toBeNull();
    expect(store.get(r.id)?.lastStatus).toBe("ok");
    expect(onFired).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: r.id, sessionId: "ses-7", status: "ok" }),
    );
  });

  it("markFired increments consecutiveErrors and resets on ok", () => {
    const store = new RoutineStore();
    const r = store.create({
      name: "errs",
      cron: "* * * * *",
      prompt: "p",
      delivery: { kind: "silent" },
      enabled: true,
    });
    store.markFired(r.id, null, "error", new Date().toISOString(), "boom");
    store.markFired(r.id, null, "error", new Date().toISOString(), "boom");
    expect(store.get(r.id)?.consecutiveErrors).toBe(2);
    expect(store.get(r.id)?.lastError).toBe("boom");
    store.markFired(r.id, "s1", "ok");
    expect(store.get(r.id)?.consecutiveErrors).toBe(0);
  });
});

describe("RoutineStore (file-backed)", () => {
  it("persists jobs.json and reloads on a fresh instance", () => {
    const dir = tmp();
    try {
      const a = new RoutineStore({}, { dataDir: dir });
      const r = a.create({
        name: "persisted",
        cron: "* * * * *",
        prompt: "p",
        delivery: { kind: "silent" },
        enabled: true,
      });
      expect(existsSync(join(dir, "cron", "jobs.json"))).toBe(true);
      const b = new RoutineStore({}, { dataDir: dir });
      expect(b.list()).toHaveLength(1);
      expect(b.get(r.id)?.name).toBe("persisted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("state.json is split from jobs.json", () => {
    const dir = tmp();
    try {
      const store = new RoutineStore({}, { dataDir: dir });
      const r = store.create({
        name: "split",
        cron: "* * * * *",
        prompt: "p",
        delivery: { kind: "silent" },
        enabled: true,
      });
      store.markFired(r.id, "s1", "ok");
      const jobs = JSON.parse(readFileSync(join(dir, "cron", "jobs.json"), "utf8")) as {
        jobs: Array<Record<string, unknown>>;
      };
      const state = JSON.parse(readFileSync(join(dir, "cron", "state.json"), "utf8")) as {
        state: Record<string, { lastStatus: string }>;
      };
      // Job config does not carry runtime fields.
      expect(jobs.jobs[0]).not.toHaveProperty("lastRunAt");
      expect(jobs.jobs[0]).not.toHaveProperty("lastStatus");
      expect(state.state[r.id]?.lastStatus).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
