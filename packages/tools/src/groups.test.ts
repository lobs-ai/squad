import { describe, expect, it, vi } from "vitest";
import {
  DescribeToolGroupTool,
  ToolGroupRegistry,
  formatGroupIndexForPrompt,
  type ToolGroup,
} from "./groups.js";

const fs: ToolGroup = {
  name: "filesystem",
  description: "Read/write files",
  guidance: "Use read before write.",
  toolNames: ["read", "write"],
  default: true,
};

const cron: ToolGroup = {
  name: "cron",
  description: "Schedule recurring or one-off work",
  guidance: "Pick cron / interval / once.",
  toolNames: ["create_cron_job", "list_cron_jobs"],
};

const tasks: ToolGroup = {
  name: "tasks",
  description: "Shared task list",
  guidance: "Create tasks for >3 step plans.",
  toolNames: ["create_task", "update_task"],
};

describe("ToolGroupRegistry.activeToolNames", () => {
  it("returns default-group tools when nothing is unlocked", () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron, tasks]);
    expect(new Set(reg.activeToolNames([]))).toEqual(new Set(["read", "write"]));
  });

  it("merges default + unlocked groups, deduped", () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron, tasks]);
    expect(new Set(reg.activeToolNames(["cron"]))).toEqual(
      new Set(["read", "write", "create_cron_job", "list_cron_jobs"]),
    );
  });

  it("ignores unknown group names", () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron]);
    expect(new Set(reg.activeToolNames(["bogus"]))).toEqual(new Set(["read", "write"]));
  });
});

describe("formatGroupIndexForPrompt", () => {
  it("returns empty string when no lazy groups", () => {
    expect(formatGroupIndexForPrompt([])).toBe("");
  });

  it("renders one entry per lazy group with name + description", () => {
    const out = formatGroupIndexForPrompt([cron, tasks]);
    expect(out).toContain('<group name="cron">Schedule recurring or one-off work</group>');
    expect(out).toContain('<group name="tasks">Shared task list</group>');
    expect(out).toContain("describe_tool_group");
  });

  it("escapes XML special characters in descriptions", () => {
    const g: ToolGroup = { ...cron, description: "a & b < c" };
    expect(formatGroupIndexForPrompt([g])).toContain("a &amp; b &lt; c");
  });
});

describe("DescribeToolGroupTool", () => {
  it("calls onUnlock for each lazy group and returns guidance", async () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron, tasks]);
    const onUnlock = vi.fn();
    const tool = new DescribeToolGroupTool(reg, onUnlock);

    const result = await tool.run(
      { groups: ["cron", "tasks"] },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );

    expect(onUnlock).toHaveBeenCalledTimes(2);
    expect(onUnlock).toHaveBeenCalledWith("s1", "cron");
    expect(onUnlock).toHaveBeenCalledWith("s1", "tasks");
    const text = typeof result === "string" ? result : result.result;
    expect(text).toContain("Pick cron / interval / once.");
    expect(text).toContain("Create tasks for >3 step plans.");
    expect(text).toContain("Unlocked: cron, tasks");
  });

  it("accepts a string instead of array for a single group", async () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron]);
    const onUnlock = vi.fn();
    const tool = new DescribeToolGroupTool(reg, onUnlock);

    const result = await tool.run({ groups: "cron" }, { cwd: "/tmp" });
    expect(onUnlock).toHaveBeenCalledWith(undefined, "cron");
    const text = typeof result === "string" ? result : result.result;
    expect(text).toContain("# cron");
  });

  it("throws when no requested group is unlockable", async () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron]);
    const tool = new DescribeToolGroupTool(reg, vi.fn());
    await expect(tool.run({ groups: ["bogus"] }, { cwd: "/tmp" })).rejects.toThrow(
      /describe_tool_group/,
    );
  });

  it("skips default groups but still unlocks the others", async () => {
    const reg = new ToolGroupRegistry().registerAll([fs, cron]);
    const onUnlock = vi.fn();
    const tool = new DescribeToolGroupTool(reg, onUnlock);

    const result = await tool.run({ groups: ["filesystem", "cron"] }, { cwd: "/tmp" });
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(onUnlock).toHaveBeenCalledWith(undefined, "cron");
    const text = typeof result === "string" ? result : result.result;
    expect(text).toContain("Skipped: filesystem (already loaded)");
  });
});
