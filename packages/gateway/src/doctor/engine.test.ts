import { describe, it, expect } from "vitest";
import { Doctor } from "./engine.js";
import type { Check } from "./types.js";

function silentLogger() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    trace: noop,
    // The engine only calls error() in practice — passing a minimally-shaped
    // logger is enough.
  } as unknown as import("../logger.js").Logger;
}

function staticCheck(opts: {
  id: string;
  severity: "ok" | "warn" | "error";
  fixable?: boolean;
  fixImpl?: () => Promise<void> | void;
}): Check {
  return {
    id: opts.id,
    category: "test",
    title: opts.id,
    async run() {
      return {
        id: opts.id,
        title: opts.id,
        severity: opts.severity,
        message: opts.severity,
        fixable: opts.fixable ?? false,
      };
    },
    ...(opts.fixable
      ? {
          fix: async () => {
            await opts.fixImpl?.();
            return { id: opts.id, ok: true, message: "fixed" };
          },
        }
      : {}),
  };
}

describe("Doctor.run", () => {
  it("runs every registered check and counts severities", async () => {
    const d = new Doctor({ logger: silentLogger() });
    d.registerAll([
      staticCheck({ id: "a", severity: "ok" }),
      staticCheck({ id: "b", severity: "warn" }),
      staticCheck({ id: "c", severity: "error" }),
    ]);
    const report = await d.run();
    expect(report.diagnoses.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(report.summary).toEqual({ ok: 1, info: 0, warn: 1, error: 1 });
  });

  it("filters to the requested ids and ignores unknown ones", async () => {
    const d = new Doctor({ logger: silentLogger() });
    d.registerAll([
      staticCheck({ id: "a", severity: "ok" }),
      staticCheck({ id: "b", severity: "warn" }),
    ]);
    const report = await d.run(["b", "nonexistent"]);
    expect(report.diagnoses.map((d) => d.id)).toEqual(["b"]);
  });

  it("traps thrown checks into an error diagnosis instead of bubbling", async () => {
    const d = new Doctor({ logger: silentLogger() });
    d.register({
      id: "boom",
      category: "test",
      title: "boom",
      async run() {
        throw new Error("kaboom");
      },
    });
    const report = await d.run();
    expect(report.diagnoses[0]?.severity).toBe("error");
    expect(report.diagnoses[0]?.message).toContain("kaboom");
    expect(report.diagnoses[0]?.fixable).toBe(false);
  });
});

describe("Doctor.list", () => {
  it("reports the fixable flag for each check", () => {
    const d = new Doctor({ logger: silentLogger() });
    d.register(staticCheck({ id: "a", severity: "warn", fixable: true }));
    d.register(staticCheck({ id: "b", severity: "warn" }));
    const entries = d.list();
    expect(entries.find((e) => e.id === "a")?.fixable).toBe(true);
    expect(entries.find((e) => e.id === "b")?.fixable).toBe(false);
  });

  it("rejects duplicate registrations", () => {
    const d = new Doctor({ logger: silentLogger() });
    d.register(staticCheck({ id: "a", severity: "ok" }));
    expect(() => d.register(staticCheck({ id: "a", severity: "ok" }))).toThrow(/duplicate/);
  });
});

describe("Doctor.fix", () => {
  it("returns ok=false for unknown ids", async () => {
    const d = new Doctor({ logger: silentLogger() });
    const out = await d.fix("missing");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/unknown check/);
  });

  it("returns ok=false when the check has no fix", async () => {
    const d = new Doctor({ logger: silentLogger() });
    d.register(staticCheck({ id: "a", severity: "warn", fixable: false }));
    const out = await d.fix("a");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/no fix/);
  });

  it("short-circuits with ok=true when the check is already healthy", async () => {
    const d = new Doctor({ logger: silentLogger() });
    let fixCalls = 0;
    d.register(staticCheck({ id: "a", severity: "ok", fixable: true, fixImpl: () => { fixCalls += 1; } }));
    const out = await d.fix("a");
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/already healthy/);
    expect(fixCalls).toBe(0);
  });

  it("invokes the fix when the check is unhealthy and fixable", async () => {
    const d = new Doctor({ logger: silentLogger() });
    let fixCalls = 0;
    d.register(staticCheck({ id: "a", severity: "warn", fixable: true, fixImpl: () => { fixCalls += 1; } }));
    const out = await d.fix("a");
    expect(out.ok).toBe(true);
    expect(out.message).toBe("fixed");
    expect(fixCalls).toBe(1);
  });

  it("traps a thrown fix into ok=false instead of bubbling", async () => {
    const d = new Doctor({ logger: silentLogger() });
    d.register({
      id: "a",
      category: "test",
      title: "a",
      async run() {
        return { id: "a", title: "a", severity: "warn", message: "bad", fixable: true };
      },
      async fix() {
        throw new Error("repair failed");
      },
    });
    const out = await d.fix("a");
    expect(out.ok).toBe(false);
    expect(out.message).toContain("repair failed");
  });
});
