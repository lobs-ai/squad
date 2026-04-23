import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DatabaseHandle } from "./index.js";
import { SessionStore } from "./sessions.js";

let dir: string;
let db: DatabaseHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "squad-sessions-"));
  db = openDb({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("create fills defaults and returns a record", () => {
    const store = new SessionStore(db);
    const s = store.create({ model: "claude-sonnet-4-5", title: "root" });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.title).toBe("root");
    expect(s.deliveryMode).toBe("interrupt");
    expect(s.status).toBe("idle");
    expect(s.parentSessionId).toBeNull();
    expect(s.tokensIn).toBe(0);
  });

  it("create honours store-level defaults and explicit overrides", () => {
    const store = new SessionStore(db, { deliveryMode: "queue" });
    const a = store.create({ model: "m" });
    expect(a.deliveryMode).toBe("queue");
    const b = store.create({ model: "m", deliveryMode: "interrupt" });
    expect(b.deliveryMode).toBe("interrupt");
  });

  it("get throws for unknown ids; tryGet returns null", () => {
    const store = new SessionStore(db);
    expect(() => store.get("missing")).toThrow(/not found/);
    expect(store.tryGet("missing")).toBeNull();
  });

  it("setStatus + setDeliveryMode + addTokens update the persisted row", () => {
    const store = new SessionStore(db);
    const s = store.create({ model: "m" });
    store.setStatus(s.id, "running");
    store.setDeliveryMode(s.id, "queue");
    store.addTokens(s.id, 10, 5);
    store.addTokens(s.id, 1, 2);
    const after = store.get(s.id);
    expect(after.status).toBe("running");
    expect(after.deliveryMode).toBe("queue");
    expect(after.tokensIn).toBe(11);
    expect(after.tokensOut).toBe(7);
  });

  it("findByRemote returns match or null", () => {
    const store = new SessionStore(db);
    const created = store.create({ model: "m", platform: "discord", remoteId: "123" });
    expect(store.findByRemote("discord", "123")?.id).toBe(created.id);
    expect(store.findByRemote("discord", "999")).toBeNull();
  });

  it("list supports scoping to root sessions and to a specific parent", () => {
    const store = new SessionStore(db);
    const root = store.create({ model: "m", title: "root" });
    const child = store.create({ model: "m", parentSessionId: root.id, title: "child" });
    store.create({ model: "m", title: "other-root" });

    const roots = store.list({ parentSessionId: null, limit: 50 });
    expect(roots.map((s) => s.id).sort()).toEqual([root.id, roots.find((s) => s.title === "other-root")!.id].sort());

    const children = store.list({ parentSessionId: root.id, limit: 50 });
    expect(children.map((s) => s.id)).toEqual([child.id]);

    const all = store.list({ limit: 50 });
    expect(all.length).toBe(3);
  });

  it("rootId walks up the parent chain", () => {
    const store = new SessionStore(db);
    const root = store.create({ model: "m" });
    const mid = store.create({ model: "m", parentSessionId: root.id });
    const leaf = store.create({ model: "m", parentSessionId: mid.id });
    expect(store.rootId(leaf.id)).toBe(root.id);
    expect(store.rootId(root.id)).toBe(root.id);
  });

  it("rootId throws when a session id does not exist", () => {
    const store = new SessionStore(db);
    expect(() => store.rootId("nope")).toThrow(/not found/);
  });
});
