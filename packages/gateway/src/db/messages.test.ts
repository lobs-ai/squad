import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DatabaseHandle } from "./index.js";
import { SessionStore } from "./sessions.js";
import { MessageStore } from "./messages.js";

let dir: string;
let db: DatabaseHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "squad-messages-"));
  db = openDb({ path: join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MessageStore", () => {
  it("append persists content and returns the full record", () => {
    const sessions = new SessionStore(db);
    const store = new MessageStore(db);
    const s = sessions.create({ model: "m" });
    const m = store.append({
      sessionId: s.id,
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.sessionId).toBe(s.id);
    expect(m.role).toBe("user");
    expect(m.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("get returns the same record; throws when id is unknown", () => {
    const sessions = new SessionStore(db);
    const store = new MessageStore(db);
    const s = sessions.create({ model: "m" });
    const m = store.append({ sessionId: s.id, role: "user", content: [{ type: "text", text: "hi" }] });
    expect(store.get(m.id).content).toEqual(m.content);
    expect(() => store.get("missing")).toThrow(/not found/);
  });

  it("listForSession returns messages in chronological order", async () => {
    const sessions = new SessionStore(db);
    const store = new MessageStore(db);
    const s = sessions.create({ model: "m" });
    store.append({ sessionId: s.id, role: "user", content: [{ type: "text", text: "1" }] });
    // Tick so created_at differs — millisecond precision in ISO timestamps.
    await new Promise((r) => setTimeout(r, 5));
    store.append({ sessionId: s.id, role: "assistant", content: [{ type: "text", text: "2" }] });
    await new Promise((r) => setTimeout(r, 5));
    store.append({ sessionId: s.id, role: "user", content: [{ type: "text", text: "3" }] });

    const history = store.listForSession(s.id, 100);
    expect(history.map((m) => (m.content[0] as { text: string }).text)).toEqual(["1", "2", "3"]);
  });

  it("listForSession honours limit + before cursor", async () => {
    const sessions = new SessionStore(db);
    const store = new MessageStore(db);
    const s = sessions.create({ model: "m" });
    const a = store.append({ sessionId: s.id, role: "user", content: [{ type: "text", text: "1" }] });
    await new Promise((r) => setTimeout(r, 5));
    store.append({ sessionId: s.id, role: "assistant", content: [{ type: "text", text: "2" }] });
    await new Promise((r) => setTimeout(r, 5));
    const c = store.append({ sessionId: s.id, role: "user", content: [{ type: "text", text: "3" }] });

    const limited = store.listForSession(s.id, 2);
    expect(limited.length).toBe(2);

    // before=c.createdAt should exclude c.
    const earlier = store.listForSession(s.id, 10, c.createdAt);
    expect(earlier.length).toBe(2);
    expect(earlier[0]!.id).toBe(a.id);
  });

  it("listForSession returns [] for an unknown or empty session", () => {
    const store = new MessageStore(db);
    expect(store.listForSession("no-such", 10)).toEqual([]);
  });
});
