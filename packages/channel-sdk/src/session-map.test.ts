import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
});
