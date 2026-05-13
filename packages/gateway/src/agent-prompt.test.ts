import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSquadSystemPrompt,
  CORE_DIR,
  CORE_FILES,
  loadCoreFiles,
  seedCoreFiles,
} from "./agent-prompt.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "squad-prompt-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("seedCoreFiles", () => {
  it("creates the core dir and all three files when missing", () => {
    seedCoreFiles(workspace);
    for (const name of CORE_FILES) {
      const body = readFileSync(join(workspace, CORE_DIR, name), "utf8");
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain(`# ${name}`);
    }
  });

  it("never overwrites existing files", () => {
    seedCoreFiles(workspace);
    const path = join(workspace, CORE_DIR, "MEMORY.md");
    writeFileSync(path, "user-edited content");
    seedCoreFiles(workspace);
    expect(readFileSync(path, "utf8")).toBe("user-edited content");
  });
});

describe("loadCoreFiles", () => {
  it("returns empty strings when nothing exists", () => {
    const c = loadCoreFiles(workspace);
    expect(c).toEqual({ soul: "", user: "", memory: "" });
  });

  it("reads and trims existing files", () => {
    seedCoreFiles(workspace);
    writeFileSync(join(workspace, CORE_DIR, "USER.md"), "  hello\n\n");
    const c = loadCoreFiles(workspace);
    expect(c.user).toBe("hello");
    expect(c.soul.length).toBeGreaterThan(0);
    expect(c.memory.length).toBeGreaterThan(0);
  });
});

describe("buildSquadSystemPrompt", () => {
  it("includes the static Squad onboarding when core files are empty", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/tmp/work",
      coreFiles: { soul: "", user: "", memory: "" },
    });
    expect(prompt).toContain("Squad agent");
    expect(prompt).toContain("/tmp/work");
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("interrupt");
    expect(prompt).toContain("queue");
    expect(prompt).toContain("docs/agent/INDEX.md");
    expect(prompt).not.toContain(`Loaded from ${CORE_DIR}`);
  });

  it("renders only the non-empty core files", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/w",
      coreFiles: { soul: "I am calm.", user: "", memory: "no entries yet" },
    });
    expect(prompt).toContain(`Loaded from ${CORE_DIR}`);
    expect(prompt).toContain("### SOUL.md\nI am calm.");
    expect(prompt).toContain("### MEMORY.md\nno entries yet");
    expect(prompt).not.toContain("### USER.md");
  });

  it("inserts the tool-groups index when provided", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/w",
      coreFiles: { soul: "", user: "", memory: "" },
      toolGroupsIndex:
        '## Tool groups (lazy)\n\n<tool_groups>\n  <group name="cron">Schedule…</group>\n</tool_groups>',
    });
    expect(prompt).toContain('<group name="cron">Schedule…</group>');
    expect(prompt).toContain("describe_tool_group");
  });

  it("omits the tool-groups index when not provided", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/w",
      coreFiles: { soul: "", user: "", memory: "" },
    });
    expect(prompt).not.toContain("<tool_groups>");
  });

  it("emits the full squad tool guidance for non-claude-cli providers", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/w",
      coreFiles: { soul: "", user: "", memory: "" },
      provider: "anthropic",
    });
    // Full squad-flavored guidance — the file-handling rule and the
    // "tools in a drawer" line are unique to the non-CLI branch.
    expect(prompt).toContain("filesystem");
    expect(prompt).toContain("read/write/edit/ls");
    expect(prompt).toContain("tools sitting in a drawer");
  });

  it("trims squad tool guidance when provider is claude-cli", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/w",
      coreFiles: { soul: "", user: "", memory: "" },
      provider: "claude-cli",
    });
    // The redundant squad-flavored guidance is gone…
    expect(prompt).not.toContain("read/write/edit/ls");
    expect(prompt).not.toContain("Treat them like tools sitting in a drawer");
    // …but the squad-specific bits (ask_user, lazy tool groups,
    // describe_tool_group, mcp__squad__*) are still present.
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("describe_tool_group");
    expect(prompt).toContain("mcp__squad__*");
  });

  it("defaults to the full guidance when provider is undefined", () => {
    const prompt = buildSquadSystemPrompt({
      workspaceDir: "/w",
      coreFiles: { soul: "", user: "", memory: "" },
    });
    expect(prompt).toContain("read/write/edit/ls");
  });
});
