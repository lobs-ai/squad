import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import type { MemCore } from "memcore";
import { StubMemCore } from "../../test/fixtures/stub-memcore.js";
import { MemoryService, DuplicateMemoryError } from "./service.js";

const logger = pino({ level: "silent" });

let stub: StubMemCore;
let service: MemoryService;

beforeEach(() => {
  stub = new StubMemCore();
  service = new MemoryService(stub as unknown as MemCore, logger);
});

describe("MemoryService (MemCore-backed)", () => {
  it("round-trips a typed entry through propose -> get -> list", async () => {
    const entry = await service.propose({
      type: "user",
      name: "user_role",
      description: "their day job",
      body: "Backend engineer at a startup.",
    });
    expect(entry.id).toBeTruthy();
    expect(entry.type).toBe("user");
    expect(entry.scope).toBe("global"); // default for type=user
    expect(entry.confidence).toBe(0.5);

    const got = await service.get(entry.id);
    expect(got?.name).toBe("user_role");
    expect(got?.body).toBe("Backend engineer at a startup.");

    const listed = await service.list({ type: "user" });
    expect(listed.map((e) => e.name)).toContain("user_role");
  });

  it("update changes body and bumps updatedAt", async () => {
    const entry = await service.propose({
      type: "project",
      name: "auth_freeze",
      description: "release freeze date",
      body: "Mobile freeze begins 2026-03-05.",
    });
    const updated = await service.update({
      id: entry.id,
      body: "Mobile freeze begins 2026-03-12 (slipped).",
    });
    expect(updated.body).toBe("Mobile freeze begins 2026-03-12 (slipped).");
    const fresh = await service.get(entry.id);
    expect(fresh?.body).toBe("Mobile freeze begins 2026-03-12 (slipped).");
  });

  it("archive flips status and search excludes archived by default", async () => {
    const entry = await service.propose({
      type: "project",
      name: "tmp_note",
      description: "ephemeral note",
      body: "Throwaway info about the prototype.",
    });
    await service.archive(entry.id);
    const fresh = await service.get(entry.id);
    expect(fresh?.status).toBe("archived");

    const searchActive = await service.search({ query: "throwaway prototype" });
    expect(searchActive.find((h) => h.entry.id === entry.id)).toBeUndefined();

    const searchArchived = await service.search({
      query: "throwaway prototype",
      includeArchived: true,
    });
    expect(searchArchived.find((h) => h.entry.id === entry.id)).toBeDefined();
  });

  it("retrievalForTurn returns project/reference hits, ignores short queries", async () => {
    await service.propose({
      type: "project",
      name: "auth_freeze",
      description: "Mobile freeze begins 2026-03-05",
      body: "Mobile team is cutting a release branch.",
    });
    await service.propose({
      type: "user",
      name: "user_role",
      description: "User role",
      body: "Engineer.",
    });

    const hits = await service.retrievalForTurn("when does the mobile release branch land");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe("auth_freeze");
    expect(hits.some((h) => h.type === "user")).toBe(false);

    expect(await service.retrievalForTurn("hi")).toEqual([]);
  });

  it("eagerForSession freezes user+feedback per session", async () => {
    await service.propose({
      type: "user",
      name: "user_role",
      description: "their day job",
      body: "Backend engineer at a startup.",
    });
    const first = await service.eagerForSession("session-1");
    expect(first.map((e) => e.name)).toEqual(["user_role"]);

    await service.propose({
      type: "user",
      name: "user_timezone",
      description: "where they are",
      body: "Pacific time, ships late.",
    });

    const stillFrozen = await service.eagerForSession("session-1");
    expect(stillFrozen.map((e) => e.name)).toEqual(["user_role"]);

    const fresh = await service.eagerForSession("session-2");
    expect(fresh.map((e) => e.name).sort()).toEqual(["user_role", "user_timezone"]);

    service.invalidateSession("session-1");
    const refreshed = await service.eagerForSession("session-1");
    expect(refreshed.map((e) => e.name).sort()).toEqual(["user_role", "user_timezone"]);
  });

  it("rejects exact-name dupes within the same type", async () => {
    await service.propose({
      type: "project",
      name: "auth_freeze",
      description: "freeze date",
      body: "Mobile freeze begins 2026-03-05.",
    });
    await expect(
      service.propose({
        type: "project",
        name: "auth_freeze",
        description: "freeze date",
        body: "Mobile freeze begins 2026-03-05.",
      }),
    ).rejects.toBeInstanceOf(DuplicateMemoryError);
  });
});

describe("MemoryService mirror integration", () => {
  class FakeMirror {
    upserts: string[] = [];
    removes: string[] = [];
    upsert(entry: { id: string }) {
      this.upserts.push(entry.id);
    }
    remove(id: string) {
      this.removes.push(id);
    }
    getDir(): string {
      return "/tmp/fake-mirror/memory";
    }
  }

  it("mirrorMemoriesByIds writes one .md per resolved row, skips missing", async () => {
    const stubMc = new StubMemCore();
    const mirror = new FakeMirror();
    const svc = new MemoryService(stubMc as unknown as MemCore, logger, {
      containerTag: "test",
      markdownMirror: mirror as unknown as import("./markdown-mirror.js").MarkdownMemoryMirror,
    });
    // Seed two rows via propose so we get real ids.
    const a = await svc.propose({
      type: "project",
      name: "first",
      description: "an entry",
      body: "Content for the first entry.",
    });
    const b = await svc.propose({
      type: "project",
      name: "second",
      description: "an entry",
      body: "Content for the second entry.",
    });
    // propose() already mirrors once; clear so we observe only the new path.
    mirror.upserts = [];
    await svc.mirrorMemoriesByIds([a.id, "missing-id-xyz", b.id]);
    expect(mirror.upserts.sort()).toEqual([a.id, b.id].sort());
  });

  it("mirrorMemoriesByIds is a no-op when no mirror is configured", async () => {
    const stubMc = new StubMemCore();
    const svc = new MemoryService(stubMc as unknown as MemCore, logger, {
      containerTag: "test",
    });
    // Should not throw and should resolve fine even with bogus ids.
    await expect(svc.mirrorMemoriesByIds(["whatever"])).resolves.toBeUndefined();
  });

  it("mirrorMemoriesByIds with an empty list is a fast no-op", async () => {
    const stubMc = new StubMemCore();
    const mirror = new FakeMirror();
    const svc = new MemoryService(stubMc as unknown as MemCore, logger, {
      containerTag: "test",
      markdownMirror: mirror as unknown as import("./markdown-mirror.js").MarkdownMemoryMirror,
    });
    await svc.mirrorMemoriesByIds([]);
    expect(mirror.upserts).toEqual([]);
  });

  it("getMirrorDir reflects the configured mirror, null otherwise", () => {
    const stubMc = new StubMemCore();
    const mirror = new FakeMirror();
    const withMirror = new MemoryService(stubMc as unknown as MemCore, logger, {
      markdownMirror: mirror as unknown as import("./markdown-mirror.js").MarkdownMemoryMirror,
    });
    const without = new MemoryService(stubMc as unknown as MemCore, logger);
    expect(withMirror.getMirrorDir()).toBe("/tmp/fake-mirror/memory");
    expect(without.getMirrorDir()).toBeNull();
  });
});
