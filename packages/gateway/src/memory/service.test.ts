import { describe, it, expect, beforeEach, vi } from "vitest";
import pino from "pino";
import type { MemCore } from "memcore";
import { StubMemCore } from "../../test/fixtures/stub-memcore.js";
import {
  MemoryService,
  DuplicateMemoryError,
  chunkQuery,
  type EmbedderWithLimit,
} from "./service.js";

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

describe("chunkQuery", () => {
  it("returns the query unchanged when it fits", () => {
    expect(chunkQuery("hello world", 100)).toEqual(["hello world"]);
  });

  it("splits long queries into multiple windows", () => {
    const text = "abcdefghij ".repeat(200); // ~2200 chars
    const chunks = chunkQuery(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk fits the requested limit.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });

  it("respects the soft min-chunk floor for small limits", () => {
    // chunkQuery clamps small limits up to MIN_CHUNK_CHARS (400) so tiny
    // limits don't degrade into hundreds of useless overlapping fragments.
    const text = "abcdefghij ".repeat(200); // ~2200 chars
    const chunks = chunkQuery(text, 50);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
  });

  it("breaks at word boundaries when possible", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i.toString().padStart(3, "0")}`);
    const text = words.join(" "); // ~1500 chars
    const chunks = chunkQuery(text, 500);
    for (const c of chunks.slice(0, -1)) {
      const trimmed = c.trimEnd();
      // Ends on a complete word, not mid-token.
      expect(/word\d{3}$/.test(trimmed)).toBe(true);
    }
  });

  it("creates overlap so phrases at boundaries aren't lost", () => {
    // Long enough to produce >2 chunks at 500-char limit.
    const text = "AAAAA BBBBB CCCCC DDDDD EEEEE FFFFF GGGGG HHHHH IIIII JJJJJ ".repeat(30);
    const chunks = chunkQuery(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i]!.slice(-120);
      const head = chunks[i + 1]!.slice(0, 120);
      const tailGroups = tail.match(/[A-Z]{5}/g) ?? [];
      const sharesToken = tailGroups.some((g) => head.includes(g));
      expect(sharesToken).toBe(true);
    }
  });
});

describe("retrievalForTurn — chunked path", () => {
  /**
   * Tiny embedder stub that reports a deliberately small `maxInputChars`
   * so the chunking branch fires for queries we'd otherwise pass through
   * whole. The `embed` method is never called by MemoryService directly
   * (that goes through memcore.search); it exists only to satisfy the
   * Embedder interface.
   */
  function tinyEmbedder(maxInputChars: number): EmbedderWithLimit {
    return {
      maxInputChars,
      async embed({ texts }) {
        return {
          vectors: texts.map(() => [0]),
          model: "stub",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
  }

  it("falls back to single-chunk search when query fits", async () => {
    const stub = new StubMemCore();
    const svc = new MemoryService(stub as unknown as MemCore, logger, {
      embedder: tinyEmbedder(1000),
    });
    const searchSpy = vi.spyOn(stub, "search");
    await svc.propose({
      type: "project",
      name: "pasta_recipe",
      description: "default carbonara",
      body: "Use guanciale, pecorino, eggs.",
    });
    const hits = await svc.retrievalForTurn("how do I make carbonara");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe("pasta_recipe");
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  // Big-enough query to clear the MIN_CHUNK_CHARS soft floor (400) and
  // produce multiple chunks. ~1500 chars with one signal token at the
  // start and another at the very end so single-pass retrieval would
  // miss the back half.
  const filler = "padding noise text ".repeat(80); // ~1500 chars

  it("chunks long queries and runs one search per chunk", async () => {
    const stub = new StubMemCore();
    const svc = new MemoryService(stub as unknown as MemCore, logger, {
      embedder: tinyEmbedder(400),
    });
    await svc.propose({
      type: "project",
      name: "carbonara",
      description: "default carbonara recipe",
      body: "Use guanciale, pecorino, eggs.",
    });
    await svc.propose({
      type: "project",
      name: "kubernetes_upgrade",
      description: "k8s upgrade plan and timing",
      body: "Upgrade kubernetes to 1.30 by Q3.",
    });
    const searchSpy = vi.spyOn(stub, "search");
    const longQuery = `carbonara recipe question ${filler} and also when do we upgrade kubernetes`;

    const hits = await svc.retrievalForTurn(longQuery, { limit: 4 });
    expect(searchSpy.mock.calls.length).toBeGreaterThan(1);
    const names = hits.map((h) => h.name).sort();
    expect(names).toContain("carbonara");
    expect(names).toContain("kubernetes_upgrade");
  });

  it("dedupes by id across chunks", async () => {
    const stub = new StubMemCore();
    const svc = new MemoryService(stub as unknown as MemCore, logger, {
      embedder: tinyEmbedder(400),
    });
    await svc.propose({
      type: "project",
      name: "deploy_freeze",
      description: "release freeze for mobile",
      body: "Mobile deploy freeze begins 2026-03-05.",
    });

    // Token "deploy mobile" appears throughout, so every chunk hits the
    // same memory id — merge has to dedupe.
    const longQuery = `deploy mobile ${filler} deploy mobile ${filler} deploy mobile`;
    const hits = await svc.retrievalForTurn(longQuery, { limit: 4 });
    const ids = hits.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hits[0]!.name).toBe("deploy_freeze");
  });

  it("survives a per-chunk search failure without killing the turn", async () => {
    const stub = new StubMemCore();
    const svc = new MemoryService(stub as unknown as MemCore, logger, {
      embedder: tinyEmbedder(400),
    });
    await svc.propose({
      type: "project",
      name: "carbonara",
      description: "default carbonara recipe",
      body: "Use guanciale, pecorino, eggs.",
    });

    // Make the first .search() reject; subsequent calls go through.
    const realSearch = stub.search.bind(stub);
    let firstCall = true;
    vi.spyOn(stub, "search").mockImplementation(async (args) => {
      if (firstCall) {
        firstCall = false;
        throw new Error("boom");
      }
      return realSearch(args);
    });

    // Place the matching token in the second half so a chunk past the
    // failed-first-chunk has to do the work.
    const longQuery = `${filler} carbonara recipe question ${filler}`;
    const hits = await svc.retrievalForTurn(longQuery, { limit: 4 });
    expect(hits.find((h) => h.name === "carbonara")).toBeDefined();
  });
});

