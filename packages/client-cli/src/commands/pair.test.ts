import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPair, runUnpair, runPairList } from "./pair.js";

/**
 * Spin up a fake repo root (pnpm-workspace.yaml + docker/config.json), point
 * the pair module at it via SQUAD_REPO, and verify config.json edits land
 * where the gateway will read them.
 */
describe("pair command", () => {
  let root: string;
  let configPath: string;
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "squad-pair-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    mkdirSync(join(root, "docker"), { recursive: true });
    configPath = join(root, "docker", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: [
            {
              path: "../channel-discord/dist/plugin.js",
              config: {
                bot_token_env: "DISCORD_BOT_TOKEN",
                dm_policy: "allow_list",
                dm_allow_list: ["existing-user"],
              },
            },
          ],
        },
        null,
        2,
      ),
    );
    process.env.SQUAD_REPO = root;
    log.mockClear();
    stdout.mockClear();
  });

  afterEach(() => {
    delete process.env.SQUAD_REPO;
    rmSync(root, { recursive: true, force: true });
  });

  function readBack(): {
    plugins: Array<{ path: string; config: Record<string, unknown> }>;
  } {
    return JSON.parse(readFileSync(configPath, "utf8"));
  }

  it("adds a new id to the Discord plugin's allow list", () => {
    runPair("discord", "new-user");
    const cfg = readBack();
    expect(cfg.plugins[0]?.config.dm_allow_list).toEqual([
      "existing-user",
      "new-user",
    ]);
  });

  it("is idempotent: pairing an already-paired id doesn't duplicate", () => {
    runPair("discord", "existing-user");
    const cfg = readBack();
    expect(cfg.plugins[0]?.config.dm_allow_list).toEqual(["existing-user"]);
  });

  it("unpair removes a user; missing users are a no-op", () => {
    runUnpair("discord", "existing-user");
    expect(readBack().plugins[0]?.config.dm_allow_list).toEqual([]);
    // second call is a harmless miss
    runUnpair("discord", "existing-user");
    expect(readBack().plugins[0]?.config.dm_allow_list).toEqual([]);
  });

  it("refuses to pair against an uninstalled channel", () => {
    expect(() => runPair("slack", "123")).toThrow(/no slack channel plugin/);
  });

  it("errors when args are missing so the CLI can print usage", () => {
    expect(() => runPair(undefined, undefined)).toThrow(/usage/);
    expect(() => runUnpair("discord", undefined)).toThrow(/usage/);
  });

  it("pair list reports each channel's policy and members", () => {
    runPairList(undefined);
    const output = stdout.mock.calls
      .flat()
      .filter((x) => typeof x === "string")
      .join("");
    expect(output).toMatch(/discord/);
    expect(output).toMatch(/dm_policy=allow_list/);
    expect(output).toMatch(/existing-user/);
  });

  it("pair list tolerates a repo with no channel plugins", () => {
    writeFileSync(configPath, JSON.stringify({ plugins: [] }));
    runPairList(undefined);
    const output = stdout.mock.calls
      .flat()
      .filter((x) => typeof x === "string")
      .join("");
    expect(output).toMatch(/no channel plugins/);
  });
});
