import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DatabaseHandle } from "../db/index.js";
import { MemoryStore } from "./store.js";
import { MemoryService } from "./service.js";

let dir: string;
let db: DatabaseHandle;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "squad-memserv-"));
  db = openDb({ path: join(dir, "test.db") });
  store = new MemoryStore(db, { memoryDir: join(dir, "memory") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryService", () => {
  it("freezes the eager block per session and only changes after invalidate", () => {
    const svc = new MemoryService(store);
    store.propose({
      type: "user",
      name: "user_role",
      description: "their day job",
      body: "Backend engineer at a startup",
    });

    const first = svc.eagerForSession("session-1");
    expect(first.map((e) => e.name)).toEqual(["user_role"]);

    // Add a new, semantically distinct entry mid-session.
    store.propose({
      type: "user",
      name: "user_timezone",
      description: "where they are",
      body: "Pacific time, ships late",
    });

    // Same session: snapshot frozen.
    const stillFrozen = svc.eagerForSession("session-1");
    expect(stillFrozen.map((e) => e.name)).toEqual(["user_role"]);

    // A different session sees the new state.
    const fresh = svc.eagerForSession("session-2");
    expect(fresh.map((e) => e.name).sort()).toEqual(["user_role", "user_timezone"]);

    // Invalidate session-1 → it picks up the new entry on next read.
    svc.invalidateSession("session-1");
    const refreshed = svc.eagerForSession("session-1");
    expect(refreshed.map((e) => e.name).sort()).toEqual(["user_role", "user_timezone"]);
  });

  it("retrievalForTurn returns project/reference hits, ignores short queries", () => {
    const svc = new MemoryService(store);
    store.propose({
      type: "project",
      name: "auth_freeze",
      description: "Mobile freeze begins 2026-03-05",
      body: "Mobile team is cutting a release branch.",
    });
    store.propose({
      type: "user",
      name: "user_role",
      description: "User role",
      body: "Engineer.",
    });

    const hits = svc.retrievalForTurn("when does the mobile release branch land");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe("auth_freeze");
    // user-type entries are NOT in the retrieval block
    expect(hits.some((h) => h.type === "user")).toBe(false);

    // Too-short queries return empty (avoid noisy retrieval on "ok" or "hi").
    expect(svc.retrievalForTurn("hi")).toEqual([]);
  });
});
