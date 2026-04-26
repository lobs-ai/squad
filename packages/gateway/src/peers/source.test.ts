import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerSource } from "./source.js";

describe("PeerSource", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "squad-peers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns just self when no registry exists", () => {
    const source = new PeerSource({
      registryPath: join(dir, "nope.json"),
      selfName: "alpha",
      selfPort: 8080,
    });
    expect(source.list()).toEqual([
      expect.objectContaining({ name: "alpha", port: 8080, status: "healthy" }),
    ]);
  });

  it("merges self and siblings from registry, marking self healthy", () => {
    const path = join(dir, "squads.json");
    writeFileSync(
      path,
      JSON.stringify({
        squads: [
          { name: "alpha", port: 8080 },
          { name: "beta", port: 8081 },
          { name: "gamma", port: 8082, build: "abc1234", startedAt: "2025-04-01T00:00:00Z" },
        ],
      }),
    );
    const source = new PeerSource({ registryPath: path, selfName: "alpha", selfPort: 8080 });
    const peers = source.list();
    expect(peers).toHaveLength(3);
    expect(peers.find((p) => p.name === "alpha")?.status).toBe("healthy");
    expect(peers.find((p) => p.name === "beta")?.status).toBe("unknown");
    expect(peers.find((p) => p.name === "gamma")?.build).toBe("abc1234");
  });

  it("prepends self if registry omits it", () => {
    const path = join(dir, "squads.json");
    writeFileSync(path, JSON.stringify({ squads: [{ name: "beta", port: 8081 }] }));
    const source = new PeerSource({ registryPath: path, selfName: "alpha", selfPort: 8080 });
    const peers = source.list();
    expect(peers[0]?.name).toBe("alpha");
    expect(peers[1]?.name).toBe("beta");
  });
});
