import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import { CronExecutor } from "./executor.js";
import { RoutineStore } from "./store.js";
import { ensureCronPaths, readRunLog } from "./persistence.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "squad-cron-exec-"));
}

// Build the minimum shape an executor needs without spinning up SQLite.
function fakeDeps(workdir: string) {
  const paths = ensureCronPaths(workdir);
  return {
    paths,
    workdir,
    deps: {
      sessions: {} as never,
      messages: {} as never,
      toolCalls: {} as never,
      broadcast: { publish: () => undefined } as never,
      toolRegistry: new ToolRegistry(),
      logger: silentLogger,
      workspaceDir: workdir,
      defaultModel: "stub-model",
      defaultFallbacks: [] as string[],
      paths,
    },
  };
}

describe("CronExecutor — script payload", () => {
  it("captures stdout and writes a successful run-log entry", async () => {
    const dir = tmp();
    try {
      const { deps, paths } = fakeDeps(dir);
      const exec = new CronExecutor(deps);
      const store = new RoutineStore({}, { dataDir: dir });
      const r = store.create({
        name: "echo",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        payload: { kind: "script", command: "sh", args: ["-c", "echo hello"] },
        session: { kind: "new" },
        delivery: { kind: "silent" },
      });
      const result = await exec.execute(store.get(r.id)!);
      expect(result.status).toBe("ok");
      expect(result.sessionId).toBeNull();
      const runs = readRunLog(paths.runs, r.id, { limit: 5 });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("ok");
      expect(runs[0]!.payloadKind).toBe("script");
      expect(runs[0]!.output).toContain("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records error when the script exits non-zero", async () => {
    const dir = tmp();
    try {
      const { deps, paths } = fakeDeps(dir);
      const exec = new CronExecutor(deps);
      const store = new RoutineStore({}, { dataDir: dir });
      const r = store.create({
        name: "fail",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        payload: { kind: "script", command: "sh", args: ["-c", "exit 7"] },
        session: { kind: "new" },
        delivery: { kind: "silent" },
      });
      const result = await exec.execute(store.get(r.id)!);
      expect(result.status).toBe("error");
      expect(result.error).toContain("exit code 7");
      const runs = readRunLog(paths.runs, r.id, { limit: 5 });
      expect(runs[0]!.status).toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors the [SILENT] wake gate", async () => {
    const dir = tmp();
    try {
      const { deps, paths } = fakeDeps(dir);
      const exec = new CronExecutor(deps);
      const store = new RoutineStore({}, { dataDir: dir });
      const r = store.create({
        name: "silent",
        enabled: true,
        schedule: { kind: "cron", expr: "* * * * *" },
        payload: {
          kind: "script",
          command: "sh",
          args: ["-c", "echo '[SILENT] not delivered'"],
        },
        session: { kind: "new" },
        delivery: { kind: "dashboard" },
      });
      await exec.execute(store.get(r.id)!);
      const runs = readRunLog(paths.runs, r.id, { limit: 5 });
      expect(runs[0]!.delivery?.error).toBe("wake-gate-silent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("persistence", () => {
  it("ensureCronPaths creates the layout idempotently", () => {
    const dir = tmp();
    try {
      const a = ensureCronPaths(dir);
      const b = ensureCronPaths(dir);
      expect(a.root).toBe(b.root);
      expect(existsSync(a.runs)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendRunLog → readRunLog round-trips", async () => {
    const dir = tmp();
    try {
      const paths = ensureCronPaths(dir);
      const { appendRunLog } = await import("./persistence.js");
      appendRunLog(paths.runs, "rt_one", {
        ts: "2026-04-30T00:00:00Z",
        status: "ok",
        durationMs: 12,
        payloadKind: "prompt",
      });
      appendRunLog(paths.runs, "rt_one", {
        ts: "2026-04-30T00:00:01Z",
        status: "error",
        durationMs: 13,
        payloadKind: "prompt",
        error: "x",
      });
      const all = readRunLog(paths.runs, "rt_one", { limit: 10 });
      expect(all).toHaveLength(2);
      // Newest first.
      expect(all[0]!.status).toBe("error");
      const onlyOk = readRunLog(paths.runs, "rt_one", { limit: 10, status: "ok" });
      expect(onlyOk).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe jobIds", async () => {
    const dir = tmp();
    try {
      const paths = ensureCronPaths(dir);
      const { appendRunLog } = await import("./persistence.js");
      expect(() =>
        appendRunLog(paths.runs, "../etc/passwd", {
          ts: "2026-04-30T00:00:00Z",
          status: "ok",
          durationMs: 1,
          payloadKind: "prompt",
        }),
      ).toThrow();
      expect(readRunLog(paths.runs, "../etc/passwd", { limit: 1 })).toEqual([]);
      void readFileSync;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
