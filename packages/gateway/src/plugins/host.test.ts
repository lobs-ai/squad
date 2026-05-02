import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, ToolGroupRegistry } from "@squad/tools";
import { PluginHost, type PluginHostDeps } from "./host.js";
import { SubagentRegistry } from "../subagents/registry.js";
import type { LLMClient } from "@squad/llm";
import type { Logger } from "../logger.js";
import type {
  ApprovalPolicy,
  ChannelHandle,
  RoutineDescriptor,
  SkillDescriptor,
} from "@squad/plugin-sdk";

function noopLogger(): Logger {
  const fn = () => {};
  return { info: fn, warn: fn, error: fn, debug: fn, trace: fn, fatal: fn } as unknown as Logger;
}

function makeDeps(extras: Partial<PluginHostDeps> = {}): PluginHostDeps {
  return {
    toolRegistry: new ToolRegistry(),
    toolGroups: new ToolGroupRegistry(),
    subagentRegistry: new SubagentRegistry(),
    logger: noopLogger(),
    providers: new Map<string, LLMClient>(),
    routines: [] as RoutineDescriptor[],
    skills: [] as SkillDescriptor[],
    approvalPolicies: [] as ApprovalPolicy[],
    channels: [] as ChannelHandle[],
    commands: [],
    toolsets: [],
    registerDelivery: () => {},
    registerHttpRoute: () => {},
    ...extras,
  };
}

describe("PluginHost", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "squad-plugins-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function writePlugin(name: string, body: string): string {
    const path = join(tmp, `${name}.mjs`);
    writeFileSync(path, body);
    return path;
  }

  it("loads a plugin and invokes register with a scoped GatewayAPI", async () => {
    const path = writePlugin(
      "basic",
      `export default {
        id: "p1", name: "P", version: "0", kinds: ["skill"],
        register(api) { api.skills.register({ name: "hello", systemPromptFragment: "hi" }); },
      };`,
    );
    const deps = makeDeps();
    const host = new PluginHost(deps);
    const loaded = await host.load(path);
    expect(loaded.descriptor.id).toBe("p1");
    expect(deps.skills).toEqual([{ name: "hello", systemPromptFragment: "hi" }]);
    expect(host.list().map((d) => d.id)).toEqual(["p1"]);
  });

  it("threads config into the plugin at load time", async () => {
    const path = writePlugin(
      "config",
      `export default {
        id: "p2", name: "P2", version: "0", kinds: ["skill"],
        register(api) { api.skills.register({ name: api.config.hello }); },
      };`,
    );
    const deps = makeDeps();
    const host = new PluginHost(deps);
    await host.load(path, { hello: "world" });
    expect(deps.skills[0]?.name).toBe("world");
  });

  it("invokes cleanup on unload and removes from the list", async () => {
    const path = writePlugin(
      "cleanup",
      `let cleaned = false;
      export default {
        id: "p3", name: "P3", version: "0", kinds: ["skill"],
        register() { return () => { cleaned = true; globalThis.__pluginCleaned = true; }; },
      };`,
    );
    const host = new PluginHost(makeDeps());
    await host.load(path);
    expect(host.list().map((d) => d.id)).toEqual(["p3"]);
    await host.unload("p3");
    expect(host.list()).toEqual([]);
    expect((globalThis as Record<string, unknown>).__pluginCleaned).toBe(true);
  });

  it("rejects plugins without a valid default export", async () => {
    const path = writePlugin("broken", `export const notDefault = 1;`);
    const host = new PluginHost(makeDeps());
    await expect(host.load(path)).rejects.toThrow(/no valid default export/);
  });

  it("unload is a no-op for unknown ids", async () => {
    const host = new PluginHost(makeDeps());
    await expect(host.unload("never-loaded")).resolves.toBeUndefined();
  });

  it("collects channel handles when a plugin registers one", async () => {
    const path = writePlugin(
      "channel",
      `export default {
        id: "c1", name: "C1", version: "0", kinds: ["channel"],
        register(api) {
          api.channels.register({
            id: "stub",
            start: async () => { globalThis.__started = true; },
            stop: async () => { globalThis.__stopped = true; },
          });
        },
      };`,
    );
    const deps = makeDeps();
    const host = new PluginHost(deps);
    await host.load(path);
    expect(deps.channels).toHaveLength(1);
    expect(deps.channels[0]?.id).toBe("stub");
    await deps.channels[0]?.start();
    await deps.channels[0]?.stop();
    expect((globalThis as Record<string, unknown>).__started).toBe(true);
    expect((globalThis as Record<string, unknown>).__stopped).toBe(true);
  });

  it("captures ui.contribute calls and exposes them in records()", async () => {
    const path = writePlugin(
      "ui",
      `export default {
        id: "ui1", name: "Q", version: "0", kinds: ["routine"],
        register(api) {
          api.ui.contribute({ slot: "navTab", id: "queue", label: "Queue", icon: "spark" });
          api.ui.contribute({ slot: "overviewWidget", id: "queue-card", label: "Queue depth" });
        },
      };`,
    );
    const host = new PluginHost(makeDeps());
    await host.load(path);
    const rec = host.recordFor("ui1");
    expect(rec).not.toBeNull();
    expect(rec!.uiContributions).toHaveLength(2);
    expect(rec!.uiContributions.map((c) => c.slot)).toEqual(["navTab", "overviewWidget"]);
    expect(rec!.uiContributions[0]?.icon).toBe("spark");
  });

  it("forwards http.register calls to the host's registerHttpRoute", async () => {
    const path = writePlugin(
      "http",
      `export default {
        id: "h1", name: "H", version: "0", kinds: ["tool"],
        register(api) {
          api.http.register("GET", "/oauth/google/callback", async (req, res) => {
            res.writeHead(200); res.end("ok");
          });
        },
      };`,
    );
    const calls: { method: string; path: string }[] = [];
    const host = new PluginHost(
      makeDeps({
        registerHttpRoute: (method, p) => {
          calls.push({ method, path: p });
        },
      }),
    );
    await host.load(path);
    expect(calls).toEqual([{ method: "GET", path: "/oauth/google/callback" }]);
  });

  it("throws when a plugin calls api.http.register with no host route registry", async () => {
    const path = writePlugin(
      "http-no-host",
      `export default {
        id: "h2", name: "H2", version: "0", kinds: ["tool"],
        register(api) { api.http.register("GET", "/x", async () => {}); },
      };`,
    );
    const deps = makeDeps();
    delete (deps as Partial<PluginHostDeps>).registerHttpRoute;
    const host = new PluginHost(deps);
    await expect(host.load(path)).rejects.toThrow(/no HTTP server attached/);
  });

  it("setEnabled / setConfig / reload notify onPluginChanged", async () => {
    const path = writePlugin(
      "live",
      `export default {
        id: "live", name: "L", version: "0", kinds: ["skill"],
        register() {},
      };`,
    );
    const onPluginChanged = vi.fn();
    const host = new PluginHost(makeDeps({ onPluginChanged }));
    await host.load(path);
    onPluginChanged.mockClear();
    host.setEnabled("live", false);
    expect(onPluginChanged).toHaveBeenCalledOnce();
    host.setConfig("live", { tweak: 1 });
    expect(onPluginChanged).toHaveBeenCalledTimes(2);
    await host.reload("live");
    // load fires once, reload notify after that → 2 more events.
    expect(onPluginChanged).toHaveBeenCalledTimes(4);
    expect(host.recordFor("live")?.enabled).toBe(false);
    expect(host.recordFor("live")?.config).toEqual({ tweak: 1 });
  });
});
