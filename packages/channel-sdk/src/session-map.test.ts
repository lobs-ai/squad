import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMap } from "./session-map.js";

let dataDir: string | null = null;

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe("SessionMap", () => {
  it("persists entries across instances", () => {
    dataDir = mkdtempSync(join(tmpdir(), "squad-smap-"));
    const path = join(dataDir, "sessions.jsonl");

    const first = new SessionMap(path);
    first.set("guild:1:channel:2:user:3", "sess-abc");
    first.set("dm:user:4", "sess-xyz");

    const second = new SessionMap(path);
    expect(second.get("guild:1:channel:2:user:3")).toBe("sess-abc");
    expect(second.get("dm:user:4")).toBe("sess-xyz");
    expect(second.get("nonexistent")).toBeUndefined();
  });

  it("updates an existing key in place", () => {
    dataDir = mkdtempSync(join(tmpdir(), "squad-smap-"));
    const path = join(dataDir, "sessions.jsonl");

    const m = new SessionMap(path);
    m.set("k", "a");
    m.set("k", "b");
    expect(m.get("k")).toBe("b");
    expect(new SessionMap(path).get("k")).toBe("b");
  });

  it("creates the parent directory when the file does not exist yet", () => {
    dataDir = mkdtempSync(join(tmpdir(), "squad-smap-"));
    const path = join(dataDir, "nested", "deeper", "sessions.jsonl");
    const m = new SessionMap(path);
    m.set("k", "v");
    expect(m.get("k")).toBe("v");
  });

  it("skips corrupt lines without throwing", () => {
    dataDir = mkdtempSync(join(tmpdir(), "squad-smap-"));
    const path = join(dataDir, "sessions.jsonl");
    const first = new SessionMap(path);
    first.set("good", "yes");
    // Append a garbage line.
    appendFileSync(path, "{not-json}\n");
    const reloaded = new SessionMap(path);
    expect(reloaded.get("good")).toBe("yes");
  });
});
