import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import { boot, type BootedGateway } from "../../src/index.js";
import { StubMemCore } from "../fixtures/stub-memcore.js";
import type { MemCore } from "memcore";

/**
 * End-to-end check for the plugin-as-channel contract. Writes a stub channel
 * plugin to disk, loads it through the gateway's boot path, and asserts the
 * gateway invoked `start()` when `startChannels()` was called and `stop()`
 * during `close()`. The plugin reports its lifecycle transitions via writes
 * to a temp file so we don't rely on shared globals across imports.
 */
describe("gateway channel plugin lifecycle", () => {
  let tmp: string;
  let booted: BootedGateway | null = null;
  let transcriptPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "squad-channel-plugin-"));
    transcriptPath = join(tmp, "transcript.log");
    writeFileSync(transcriptPath, "", "utf8");
    booted = null;
  });

  afterEach(async () => {
    if (booted) await booted.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeStubPlugin(): string {
    const path = join(tmp, "stub-channel.mjs");
    writeFileSync(
      path,
      `import { appendFileSync } from "node:fs";
       export default {
         id: "stub-channel",
         name: "Stub Channel",
         version: "0.0.1",
         kinds: ["channel"],
         register(api) {
           const log = (line) => appendFileSync(api.config.transcriptPath, line + "\\n");
           api.channels.register({
             id: api.config.channelId ?? "stub",
             start: async () => { log("start"); },
             stop: async () => { log("stop"); },
           });
           log("register");
         },
       };`,
      "utf8",
    );
    return path;
  }

  async function readTranscript(): Promise<string[]> {
    const { readFileSync } = await import("node:fs");
    return readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  }

  it("loads the plugin, drives start() after boot and stop() on close", async () => {
    const pluginPath = writeStubPlugin();
    booted = await boot({
      memcoreOverride: new StubMemCore() as unknown as MemCore,
      config: {
        server: { host: "127.0.0.1", port: 0, data_dir: tmp },
        auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
        llm: {
          primary: { model: "claude-sonnet-4-5" },
          fallbacks: [],
          providers: {},
        },
        subagents: {
          max_concurrent_global: 8,
          max_concurrent_per_parent: 4,
          max_tree_depth: 3,
        },
        policy: {
          approvals: {
            default: "tag-match",
            require_for_tags: ["write", "exec", "network"],
            timeout_seconds: 120,
          },
        },
        plugins: [
          {
            path: pluginPath,
            config: { transcriptPath, channelId: "stub-a" },
          },
        ],
      },
      toolRegistry: new ToolRegistry(),
    });

    // register runs during boot; start should NOT have run yet.
    expect(await readTranscript()).toEqual(["register"]);

    await booted.startChannels();
    expect(await readTranscript()).toEqual(["register", "start"]);

    await booted.close();
    booted = null;
    expect(await readTranscript()).toEqual(["register", "start", "stop"]);
  });

  it("one channel failing to start does not block sibling channels", async () => {
    const pluginPath = writeStubPlugin();
    const failingPath = join(tmp, "failing.mjs");
    writeFileSync(
      failingPath,
      `export default {
         id: "failing-channel",
         name: "Failing",
         version: "0.0.1",
         kinds: ["channel"],
         register(api) {
           api.channels.register({
             id: "boom",
             start: async () => { throw new Error("boom"); },
             stop: async () => {},
           });
         },
       };`,
      "utf8",
    );

    booted = await boot({
      memcoreOverride: new StubMemCore() as unknown as MemCore,
      config: {
        server: { host: "127.0.0.1", port: 0, data_dir: tmp },
        auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
        llm: {
          primary: { model: "claude-sonnet-4-5" },
          fallbacks: [],
          providers: {},
        },
        subagents: {
          max_concurrent_global: 8,
          max_concurrent_per_parent: 4,
          max_tree_depth: 3,
        },
        policy: {
          approvals: {
            default: "tag-match",
            require_for_tags: ["write", "exec", "network"],
            timeout_seconds: 120,
          },
        },
        plugins: [
          { path: failingPath, config: {} },
          { path: pluginPath, config: { transcriptPath, channelId: "stub-b" } },
        ],
      },
      toolRegistry: new ToolRegistry(),
    });

    await expect(booted.startChannels()).resolves.toBeUndefined();
    expect(await readTranscript()).toEqual(["register", "start"]);
  });
});
