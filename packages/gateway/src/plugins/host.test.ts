import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
    runtime: () => ({
      serverHost: "127.0.0.1",
      serverPort: 0,
      publicBaseUrl: "http://127.0.0.1:0",
    }),
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

  it("evicts tool + tool-group registrations on unload before running cleanup", async () => {
    const path = writePlugin(
      "tools",
      `export default {
        id: "p-tools", name: "PT", version: "0", kinds: ["tool"],
        register(api) {
          let closed = false;
          const def = {
            name: "ping",
            description: "ping",
            input_schema: { type: "object" },
          };
          api.tools.register({
            name: "ping",
            description: "ping",
            inputSchema: { type: "object" },
            tags: [],
            toEntry: () => ({
              definition: def,
              executor: async () => {
                if (closed) throw new Error("backing store closed");
                return "pong";
              },
            }),
            setPromptContextStore: () => {},
            run: async () => "pong",
          });
          api.toolGroups.register({
            name: "ping_group",
            description: "g",
            guidance: "g",
            toolNames: ["ping"],
          });
          return () => { closed = true; };
        },
      };`,
    );
    const deps = makeDeps();
    const host = new PluginHost(deps);
    await host.load(path);
    expect(deps.toolRegistry.has("ping")).toBe(true);
    expect(deps.toolGroups.get("ping_group")).toBeDefined();

    await host.unload("p-tools");
    expect(deps.toolRegistry.has("ping")).toBe(false);
    expect(deps.toolGroups.get("ping_group")).toBeUndefined();
  });

  it("evicts partial tool registrations when register() throws", async () => {
    const path = writePlugin(
      "tools-fail",
      `export default {
        id: "p-fail", name: "PF", version: "0", kinds: ["tool"],
        register(api) {
          api.tools.register({
            name: "half",
            description: "half",
            inputSchema: { type: "object" },
            tags: [],
            toEntry: () => ({
              definition: { name: "half", description: "half", input_schema: { type: "object" } },
              executor: async () => "half",
            }),
            setPromptContextStore: () => {},
            run: async () => "half",
          });
          throw new Error("boom");
        },
      };`,
    );
    const deps = makeDeps();
    const host = new PluginHost(deps);
    await expect(host.load(path)).rejects.toThrow(/boom/);
    expect(deps.toolRegistry.has("half")).toBe(false);
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

  describe("loadMany dependency ordering", () => {
    // Each plugin lives in its own subdir with a sibling squad.plugin.json
    // so loadManifestNear picks up the right manifest per entry.
    function writeManifestedPlugin(
      dir: string,
      id: string,
      requires: string[],
      body: string,
    ): string {
      const sub = join(tmp, dir);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "entry.mjs"), body);
      writeFileSync(
        join(sub, "squad.plugin.json"),
        JSON.stringify({
          id,
          name: id,
          version: "0.0.1",
          entry: "./entry.mjs",
          exposes: ["skill"],
          requires,
        }),
      );
      return join(sub, "entry.mjs");
    }

    function recorderPlugin(id: string): string {
      return `globalThis.__loadOrder = globalThis.__loadOrder ?? [];
        export default {
          id: "${id}", name: "${id}", version: "0.0.1", kinds: ["skill"],
          register(api) {
            globalThis.__loadOrder.push("${id}");
            api.skills.register({ name: "${id}", systemPromptFragment: "x" });
          },
        };`;
    }

    beforeEach(() => {
      (globalThis as Record<string, unknown>).__loadOrder = [];
    });

    it("loads dependencies before dependents even when listed in reverse order", async () => {
      const a = writeManifestedPlugin("dep-a", "dep.a", [], recorderPlugin("dep.a"));
      const b = writeManifestedPlugin("dep-b", "dep.b", ["dep.a"], recorderPlugin("dep.b"));
      const c = writeManifestedPlugin("dep-c", "dep.c", ["dep.b"], recorderPlugin("dep.c"));
      const host = new PluginHost(makeDeps());
      const failures = await host.loadMany([c, b, a]);
      expect(failures).toEqual([]);
      expect((globalThis as Record<string, unknown>).__loadOrder).toEqual([
        "dep.a",
        "dep.b",
        "dep.c",
      ]);
    });

    it("preserves config-order for plugins that don't depend on each other", async () => {
      const a = writeManifestedPlugin("indep-a", "indep.a", [], recorderPlugin("indep.a"));
      const b = writeManifestedPlugin("indep-b", "indep.b", [], recorderPlugin("indep.b"));
      const host = new PluginHost(makeDeps());
      await host.loadMany([b, a]);
      expect((globalThis as Record<string, unknown>).__loadOrder).toEqual([
        "indep.b",
        "indep.a",
      ]);
    });

    it("fails both members of a requires cycle and still loads unrelated plugins", async () => {
      const a = writeManifestedPlugin("cyc-a", "cyc.a", ["cyc.b"], recorderPlugin("cyc.a"));
      const b = writeManifestedPlugin("cyc-b", "cyc.b", ["cyc.a"], recorderPlugin("cyc.b"));
      const ok = writeManifestedPlugin("cyc-ok", "cyc.ok", [], recorderPlugin("cyc.ok"));
      const host = new PluginHost(makeDeps());
      const failures = await host.loadMany([a, b, ok]);
      expect(failures.length).toBe(2);
      const messages = failures.map((f) => f.error).join("\n");
      expect(messages).toMatch(/cyc\.a/);
      expect(messages).toMatch(/cyc\.b/);
      expect(messages).toMatch(/cycle/i);
      // Unrelated plugin still loaded.
      expect((globalThis as Record<string, unknown>).__loadOrder).toEqual(["cyc.ok"]);
      expect(host.list().map((d) => d.id)).toEqual(["cyc.ok"]);
      // Cycle members appear as failed records.
      const failedIds = host.failedRecords().map((r) => r.id).sort();
      expect(failedIds).toEqual(["cyc.a", "cyc.b"]);
    });

    it("auto-loads an installed dependency that's not in the entry list", async () => {
      const dep = writeManifestedPlugin(
        "auto-dep",
        "auto.dep",
        [],
        recorderPlugin("auto.dep"),
      );
      const user = writeManifestedPlugin(
        "auto-user",
        "auto.user",
        ["auto.dep"],
        recorderPlugin("auto.user"),
      );
      // resolveModule maps the bare id to the dep's entry file — same shape
      // createRequire().resolve() would produce in production.
      const resolveModule = (specifier: string) => {
        if (specifier === "auto.dep") return dep;
        throw new Error(`cannot resolve ${specifier}`);
      };
      const host = new PluginHost(makeDeps({ resolveModule }));
      const failures = await host.loadMany([user]);
      expect(failures).toEqual([]);
      expect((globalThis as Record<string, unknown>).__loadOrder).toEqual([
        "auto.dep",
        "auto.user",
      ]);
    });

    it("fails the dependent plugin when a required plugin is neither listed nor installed", async () => {
      const user = writeManifestedPlugin(
        "miss-user",
        "miss.user",
        ["miss.dep"],
        recorderPlugin("miss.user"),
      );
      const resolveModule = (specifier: string) => {
        throw new Error(`cannot resolve ${specifier}`);
      };
      const host = new PluginHost(makeDeps({ resolveModule }));
      const failures = await host.loadMany([user]);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.error).toMatch(/requires "miss\.dep" which is not loaded/);
      expect((globalThis as Record<string, unknown>).__loadOrder).toEqual([]);
    });
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
