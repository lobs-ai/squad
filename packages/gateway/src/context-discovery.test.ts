import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverContextFiles,
  discoverProgressiveContextFiles,
  renderContextFilesSection,
} from "./context-discovery.js";

describe("discoverContextFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "squad-ctx-"));
  });

  it("walks up from cwd collecting context files", () => {
    writeFileSync(join(root, "AGENTS.md"), "top-level");
    const child = join(root, "a", "b");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, "a", "CLAUDE.md"), "mid-level");
    writeFileSync(join(child, "SQUAD.md"), "deep");

    const found = discoverContextFiles(child);
    const names = found.map((f) => f.name);
    expect(names).toContain("SQUAD.md");
    expect(names).toContain("CLAUDE.md");
    expect(names).toContain("AGENTS.md");
    // Closest first.
    expect(found[0]!.name).toBe("SQUAD.md");
  });

  it("dedupes by name — closer files win", () => {
    writeFileSync(join(root, "AGENTS.md"), "top");
    const child = join(root, "x");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "AGENTS.md"), "deep");

    const found = discoverContextFiles(child);
    const agents = found.filter((f) => f.name === "AGENTS.md");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.body).toBe("deep");
  });

  it("respects token budget — drops farthest first", () => {
    const big = "x".repeat(20_000);
    writeFileSync(join(root, "AGENTS.md"), big);
    const child = join(root, "x");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "SQUAD.md"), "small");

    const found = discoverContextFiles(child, { tokenBudget: 100 });
    const names = found.map((f) => f.name);
    expect(names).toContain("SQUAD.md");
    expect(names).not.toContain("AGENTS.md");
  });

  it("ignores empty files", () => {
    writeFileSync(join(root, "AGENTS.md"), "   \n\n");
    const found = discoverContextFiles(root);
    expect(found).toHaveLength(0);
  });

  it("renders a markdown section with file paths", () => {
    writeFileSync(join(root, "AGENTS.md"), "rule one");
    const found = discoverContextFiles(root);
    const section = renderContextFilesSection(found);
    expect(section).toContain("## Project context files");
    expect(section).toContain("AGENTS.md");
    expect(section).toContain("rule one");
  });

  it("renders empty string when nothing found", () => {
    expect(renderContextFilesSection([])).toBe("");
  });
});

describe("discoverProgressiveContextFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "squad-ctx-prog-"));
  });

  it("only returns files between subdir and base", () => {
    writeFileSync(join(root, "AGENTS.md"), "outer");
    const a = join(root, "a");
    const b = join(a, "b");
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "AGENTS.md"), "mid");
    writeFileSync(join(b, "SQUAD.md"), "leaf");

    const found = discoverProgressiveContextFiles(root, b);
    const names = found.map((f) => f.name).sort();
    // Should include leaf SQUAD.md and mid AGENTS.md, NOT root AGENTS.md.
    expect(names).toEqual(["AGENTS.md", "SQUAD.md"]);
    expect(found.some((f) => f.body === "outer")).toBe(false);
  });

  it("returns empty when subdir is base", () => {
    writeFileSync(join(root, "AGENTS.md"), "x");
    expect(discoverProgressiveContextFiles(root, root)).toHaveLength(0);
  });

  it("returns empty when subdir escapes base", () => {
    expect(discoverProgressiveContextFiles(root, "/etc")).toHaveLength(0);
  });
});
