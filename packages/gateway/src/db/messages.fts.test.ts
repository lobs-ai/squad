import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DatabaseHandle } from "./index.js";
import { SessionStore } from "./sessions.js";
import { MessageStore, fts5SafeQuery } from "./messages.js";

describe("MessageStore.search (FTS5)", () => {
  let tmp: string;
  let db: DatabaseHandle;
  let sessions: SessionStore;
  let messages: MessageStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "squad-fts-"));
    db = openDb({ path: join(tmp, "squad.db") });
    sessions = new SessionStore(db);
    messages = new MessageStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seed(): { sessionA: string; sessionB: string } {
    const a = sessions.create({ model: "test", title: "A" });
    const b = sessions.create({ model: "test", title: "B" });
    messages.append({ sessionId: a.id, role: "user", content: [{ type: "text", text: "hello world" }] });
    messages.append({
      sessionId: a.id,
      role: "assistant",
      content: [{ type: "text", text: "the answer is 42 robots" }],
    });
    messages.append({
      sessionId: b.id,
      role: "user",
      content: [{ type: "text", text: "robots taking over" }],
    });
    return { sessionA: a.id, sessionB: b.id };
  }

  it("returns hits across sessions when no scope is set", () => {
    const { sessionA, sessionB } = seed();
    const hits = messages.search({ query: "robots", limit: 10 });
    const sessionsHit = new Set(hits.map((h) => h.sessionId));
    expect(sessionsHit.has(sessionA)).toBe(true);
    expect(sessionsHit.has(sessionB)).toBe(true);
    for (const hit of hits) {
      expect(hit.snippet).toContain("<<robots>>");
    }
  });

  it("scopes by sessionId when provided", () => {
    const { sessionA, sessionB } = seed();
    const hits = messages.search({ query: "robots", limit: 10, sessionId: sessionA });
    expect(hits.every((h) => h.sessionId === sessionA)).toBe(true);
    expect(hits.some((h) => h.sessionId === sessionB)).toBe(false);
  });

  it("returns an empty list for empty queries", () => {
    seed();
    expect(messages.search({ query: "", limit: 10 })).toEqual([]);
    expect(messages.search({ query: "  ", limit: 10 })).toEqual([]);
  });

  it("doesn't crash on user-typed apostrophes / parens / colons", () => {
    seed();
    expect(() => messages.search({ query: "don't (do this) at:home", limit: 10 })).not.toThrow();
  });
});

describe("fts5SafeQuery", () => {
  it("quotes each token and joins with implicit AND", () => {
    expect(fts5SafeQuery("hello world")).toBe('"hello" "world"');
  });
  it("strips operator characters", () => {
    expect(fts5SafeQuery('foo: "bar"  (baz)')).toBe('"foo" "bar" "baz"');
  });
  it("returns empty for whitespace-only input", () => {
    expect(fts5SafeQuery("   ")).toBe("");
  });
});
