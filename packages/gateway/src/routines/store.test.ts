import { describe, it, expect, vi } from "vitest";
import { RoutineStore } from "./store.js";

describe("RoutineStore", () => {
  it("create / list / update / delete round-trip", () => {
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

    const updated = store.update({ id: r.id, name: "renamed", enabled: false });
    expect(updated?.name).toBe("renamed");
    expect(updated?.enabled).toBe(false);

    expect(store.delete(r.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.delete("never")).toBe(false);
  });

  it("adoptFromPlugin is idempotent on name", () => {
    const store = new RoutineStore();
    const r1 = store.adoptFromPlugin({ name: "x", cron: "* * * * *", prompt: "p" });
    const r2 = store.adoptFromPlugin({ name: "x", cron: "* * * * *", prompt: "p" });
    expect(r1.id).toBe(r2.id);
    expect(store.list()).toHaveLength(1);
  });

  it("runNow invokes the runner, marks fired, and emits onFired", async () => {
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
    expect(onFired).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: r.id, sessionId: "ses-7" }),
    );
  });
});
