import { describe, expect, it } from "vitest";
import { generateCompose } from "./compose-gen.js";
import type { Registry } from "./registry.js";

const REG: Registry = {
  build_context: "/tmp/squad-src",
  squads: [
    { name: "alpha", port: 8081 },
    { name: "beta", port: 8082 },
  ],
  shared: { searxng_port: 8888 },
};

describe("generateCompose", () => {
  it("emits one service per squad plus searxng", () => {
    const out = generateCompose(REG);
    expect(out).toContain("squad-alpha:");
    expect(out).toContain("squad-beta:");
    expect(out).toContain("searxng:");
  });

  it("maps each squad's host port to container 8080", () => {
    const out = generateCompose(REG);
    expect(out).toMatch(/squad-alpha:[\s\S]*"8081:8080"/);
    expect(out).toMatch(/squad-beta:[\s\S]*"8082:8080"/);
  });

  it("uses absolute bind-mount paths for per-squad state (~/.squad/<name>)", () => {
    const out = generateCompose(REG);
    expect(out).toMatch(/-\s+\S+\.squad\/alpha:\/app\/docker/);
    expect(out).toMatch(/-\s+\S+\.squad\/beta:\/app\/docker/);
    // Make sure we're not still emitting the old nested ~/.squad/squads/<n>.
    expect(out).not.toMatch(/\.squad\/squads\/alpha:/);
  });

  it("labels each squad container for discovery", () => {
    const out = generateCompose(REG);
    expect(out).toContain("lobs.squad.name=alpha");
    expect(out).toContain("lobs.squad.port=8081");
    expect(out).toContain("lobs.squad.name=beta");
    expect(out).toContain("lobs.squad.port=8082");
  });

  it("uses the registry's build_context as the docker build context", () => {
    const out = generateCompose(REG);
    expect(out).toMatch(/context:\s+\/tmp\/squad-src/);
  });

  it("each squad shares the same searxng via service hostname", () => {
    const out = generateCompose(REG);
    const alphaBlock = out.split("squad-alpha:")[1]!.split("squad-beta:")[0]!;
    expect(alphaBlock).toContain("SEARXNG_URL=http://searxng:8080");
    expect(alphaBlock).toMatch(/depends_on:[\s\S]*searxng:/);
  });

  it("includes a header banner warning the file is generated", () => {
    const out = generateCompose(REG);
    expect(out.startsWith("# GENERATED")).toBe(true);
  });

  it("renders just searxng when no squads exist", () => {
    const out = generateCompose({ ...REG, squads: [] });
    expect(out).not.toContain("squad-alpha");
    expect(out).toContain("searxng:");
  });

  it("rejects an empty build_context", () => {
    expect(() => generateCompose({ ...REG, build_context: "" })).toThrow(/build_context/);
  });
});
