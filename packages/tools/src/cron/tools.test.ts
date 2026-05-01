import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../registry.js";
import type { CronBackend, CronJobSummary, CronRunSummary } from "./backend.js";
import { registerCronTools } from "./tools.js";

function fakeJob(over: Partial<CronJobSummary> = {}): CronJobSummary {
  return {
    id: "rt_1",
    name: "test",
    enabled: true,
    schedule: { kind: "cron", expr: "* * * * *" },
    payload: { kind: "prompt", messages: [{ role: "user", text: "hi" }] },
    session: { kind: "new" },
    execution: {},
    delivery: { kind: "silent" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    lastError: null,
    consecutiveErrors: 0,
    ...over,
  };
}

function fakeBackend(): CronBackend & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    list: [],
    get: [],
    create: [],
    update: [],
    delete: [],
    runNow: [],
    runs: [],
  };
  const jobs = new Map<string, CronJobSummary>();
  const runs: Record<string, CronRunSummary[]> = {};
  return {
    calls,
    async list() {
      calls.list!.push([]);
      return Array.from(jobs.values());
    },
    async get(id) {
      calls.get!.push([id]);
      return jobs.get(id) ?? null;
    },
    async create(input) {
      calls.create!.push([input]);
      const j = fakeJob({
        id: `rt_${jobs.size + 1}`,
        name: input.name,
        schedule: input.schedule,
        payload: input.payload,
        session: input.session ?? { kind: "new" },
        execution: input.execution ?? {},
        delivery: input.delivery ?? { kind: "dashboard" },
      });
      jobs.set(j.id, j);
      return j;
    },
    async update(input) {
      calls.update!.push([input]);
      const cur = jobs.get(input.id);
      if (!cur) throw new Error("nope");
      const next = { ...cur, ...input };
      jobs.set(input.id, next as CronJobSummary);
      return next as CronJobSummary;
    },
    async delete(id) {
      calls.delete!.push([id]);
      jobs.delete(id);
      return { id };
    },
    async runNow(id) {
      calls.runNow!.push([id]);
      return { sessionId: `sess-for-${id}` };
    },
    async runs(input) {
      calls.runs!.push([input]);
      return runs[input.id] ?? [];
    },
  };
}

describe("cron tools", () => {
  it("registerCronTools registers all 7 tools", () => {
    const reg = new ToolRegistry();
    registerCronTools(reg, fakeBackend());
    const names = reg.names();
    expect(names).toEqual(
      expect.arrayContaining([
        "create_cron_job",
        "update_cron_job",
        "delete_cron_job",
        "list_cron_jobs",
        "get_cron_job",
        "run_cron_job",
        "get_cron_runs",
      ]),
    );
  });

  it("create → list → get → update → run → delete round-trip via execute()", async () => {
    const reg = new ToolRegistry();
    const backend = fakeBackend();
    registerCronTools(reg, backend);

    const created = await reg.execute(
      "create_cron_job",
      {
        name: "morning",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        payload: {
          kind: "prompt",
          messages: [{ role: "user", text: "summarize my inbox" }],
        },
        execution: { model: "claude-haiku-4-5" },
        delivery: { kind: "silent" },
      },
      "/tmp",
    );
    const createdJson = JSON.parse(created.result) as { job: { id: string; name: string } };
    expect(createdJson.job.name).toBe("morning");
    expect(backend.calls.create![0]?.[0]).toMatchObject({
      name: "morning",
      execution: { model: "claude-haiku-4-5" },
    });

    const id = createdJson.job.id;
    const listed = await reg.execute("list_cron_jobs", {}, "/tmp");
    expect(JSON.parse(listed.result).jobs).toHaveLength(1);

    const got = await reg.execute("get_cron_job", { id }, "/tmp");
    expect(JSON.parse(got.result).job.id).toBe(id);

    await reg.execute("update_cron_job", { id, enabled: false }, "/tmp");
    const reGot = await reg.execute("get_cron_job", { id }, "/tmp");
    expect(JSON.parse(reGot.result).job.enabled).toBe(false);

    const ran = await reg.execute("run_cron_job", { id }, "/tmp");
    expect(JSON.parse(ran.result).sessionId).toBe(`sess-for-${id}`);

    await reg.execute("delete_cron_job", { id }, "/tmp");
    const after = await reg.execute("list_cron_jobs", {}, "/tmp");
    expect(JSON.parse(after.result).jobs).toHaveLength(0);
  });

  it("get_cron_job throws on unknown id", async () => {
    const reg = new ToolRegistry();
    registerCronTools(reg, fakeBackend());
    await expect(reg.execute("get_cron_job", { id: "missing" }, "/tmp")).rejects.toThrow();
  });

  it("get_cron_runs forwards the limit + status filter", async () => {
    const reg = new ToolRegistry();
    const backend = fakeBackend();
    const runsSpy = vi.spyOn(backend, "runs");
    registerCronTools(reg, backend);
    await reg.execute("get_cron_runs", { id: "x", limit: 5, status: "error" }, "/tmp");
    expect(runsSpy).toHaveBeenCalledWith({ id: "x", limit: 5, status: "error" });
  });

  it("create_cron_job accepts a script payload (no LLM)", async () => {
    const reg = new ToolRegistry();
    const backend = fakeBackend();
    registerCronTools(reg, backend);
    const result = await reg.execute(
      "create_cron_job",
      {
        name: "health-check",
        schedule: { kind: "interval", everyMs: 60_000 },
        payload: { kind: "script", command: "curl", args: ["-fsSL", "https://example.com"] },
        session: { kind: "isolated" },
      },
      "/tmp",
    );
    const job = JSON.parse(result.result).job as CronJobSummary;
    expect(job.payload.kind).toBe("script");
    expect(job.session.kind).toBe("isolated");
  });

  it("create_cron_job accepts an arbitrary plugin-registered delivery kind", async () => {
    const reg = new ToolRegistry();
    const backend = fakeBackend();
    registerCronTools(reg, backend);
    await reg.execute(
      "create_cron_job",
      {
        name: "alerts",
        schedule: { kind: "cron", expr: "0 * * * *" },
        payload: { kind: "prompt", messages: [{ role: "user", text: "scan logs" }] },
        delivery: { kind: "slack", extras: { channel: "#alerts", emoji: ":robot_face:" } },
      },
      "/tmp",
    );
    expect(backend.calls.create![0]?.[0]).toMatchObject({
      delivery: { kind: "slack", extras: { channel: "#alerts" } },
    });
  });

  it("create_cron_job accepts a scriptThenPrompt payload", async () => {
    const reg = new ToolRegistry();
    const backend = fakeBackend();
    registerCronTools(reg, backend);
    const result = await reg.execute(
      "create_cron_job",
      {
        name: "deploy-watcher",
        schedule: { kind: "interval", everyMs: 5 * 60_000 },
        payload: {
          kind: "scriptThenPrompt",
          command: "sh",
          args: ["-c", "scripts/check-deploy.sh"],
          prompt: {
            messages: [
              { role: "user", text: "Deploy status:\n{{output}}\n\nWhat should I do?" },
            ],
          },
        },
      },
      "/tmp",
    );
    const job = JSON.parse(result.result).job as CronJobSummary;
    expect(job.payload.kind).toBe("scriptThenPrompt");
    expect(backend.calls.create![0]?.[0]).toMatchObject({
      payload: { kind: "scriptThenPrompt", command: "sh" },
    });
  });
});
