import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import { boot, type BootedGateway } from "../../src/index.js";

let booted: BootedGateway | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (booted) await booted.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  booted = null;
  dataDir = null;
});

async function bootForTest(): Promise<BootedGateway> {
  dataDir = mkdtempSync(join(tmpdir(), "squad-tasks-"));
  booted = await boot({
    config: {
      server: { host: "127.0.0.1", port: 0, data_dir: dataDir, memory_dir: join(dataDir, "memory") },
      auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
      llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
      subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
      policy: {
        approvals: {
          default: "tag-match",
          require_for_tags: ["write", "exec", "network"],
          timeout_seconds: 120,
        },
      },
      plugins: [],
      channels: {},
    },
    toolRegistry: new ToolRegistry(),
  });
  return booted;
}

describe("tasks primitive", () => {
  it("serializes concurrent claims on the same task", async () => {
    const b = await bootForTest();
    const { tasks, sessions } = b.stores;
    const session = sessions.create({ model: "claude-sonnet-4-5", title: "race" });
    const task = await tasks.create({
      sessionId: session.id,
      subject: "pick me",
      description: "one and only winner",
    });

    // Fire off N concurrent claims; each sets a different owner.
    const owners = Array.from({ length: 10 }, (_, i) => `worker-${i}`);
    const results = await Promise.all(
      owners.map((o) => tasks.claim(session.id, task.id, o)),
    );

    // Every call sees an in_progress task with some owner. The SAME write order
    // must be reflected by a strictly growing updated_at timestamp.
    const finalOwner = tasks.get(session.id, task.id).owner;
    expect(owners).toContain(finalOwner);
    expect(results.every((r) => r.status === "in_progress")).toBe(true);

    const timestamps = results.map((r) => r.updatedAt);
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);
  });

  it("scopes task lists by session-tree root", async () => {
    const b = await bootForTest();
    const { tasks, sessions } = b.stores;
    const root = sessions.create({ model: "claude-sonnet-4-5", title: "root" });
    const child = sessions.create({
      model: "claude-sonnet-4-5",
      title: "child",
      parentSessionId: root.id,
    });

    const t1 = await tasks.create({
      sessionId: root.id,
      subject: "root task",
      description: "",
    });
    expect(tasks.list(child.id, { includeDeleted: false })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: t1.id })]),
    );
    expect(tasks.list(child.id, { includeDeleted: false })[0]!.taskListId).toBe(root.id);
  });

  it("soft-deletes tasks without removing them from the row", async () => {
    const b = await bootForTest();
    const { tasks, sessions } = b.stores;
    const s = sessions.create({ model: "claude-sonnet-4-5", title: "soft" });
    const task = await tasks.create({ sessionId: s.id, subject: "foo", description: "" });
    await tasks.softDelete(s.id, task.id);
    expect(tasks.list(s.id, { includeDeleted: false })).toHaveLength(0);
    expect(tasks.list(s.id, { includeDeleted: true })).toHaveLength(1);
    expect(tasks.list(s.id, { includeDeleted: true })[0]!.status).toBe("deleted");
  });
});
