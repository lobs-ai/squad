import { describe, it, expect } from "vitest";
import {
  GetConfigTool,
  SetConfigTool,
  UnsetConfigTool,
  ListConfigPathsTool,
  registerConfigTools,
} from "./tools.js";
import { flattenLeafPaths, splitPath, type ConfigBackend } from "./backend.js";
import { ToolRegistry } from "../registry.js";

function fakeBackend(initial: Record<string, unknown>): ConfigBackend & {
  state: Record<string, unknown>;
  setCalls: Array<{ path: string; value: unknown }>;
  unsetCalls: string[];
} {
  let state = structuredClone(initial);
  const setCalls: Array<{ path: string; value: unknown }> = [];
  const unsetCalls: string[] = [];
  return {
    get state() {
      return state;
    },
    setCalls,
    unsetCalls,
    async get() {
      return state;
    },
    async getValue(path) {
      let cur: unknown = state;
      for (const seg of splitPath(path)) {
        if (cur === null || cur === undefined) return undefined;
        if (typeof seg === "number") {
          if (!Array.isArray(cur)) return undefined;
          cur = cur[seg];
        } else {
          cur = (cur as Record<string, unknown>)[seg];
        }
      }
      return cur;
    },
    async setValue(path, value) {
      setCalls.push({ path, value });
      const segments = splitPath(path);
      let cur: Record<string, unknown> | unknown[] = state;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]!;
        // @ts-expect-error — permissive for the fake
        cur = cur[seg];
      }
      const last = segments[segments.length - 1]!;
      // @ts-expect-error — permissive for the fake
      cur[last] = value;
      return state;
    },
    async unsetValue(path) {
      unsetCalls.push(path);
      const segments = splitPath(path);
      let cur: Record<string, unknown> | unknown[] = state;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]!;
        // @ts-expect-error — permissive for the fake
        cur = cur[seg];
      }
      const last = segments[segments.length - 1]!;
      if (Array.isArray(cur) && typeof last === "number") {
        cur.splice(last, 1);
      } else {
        // @ts-expect-error — permissive for the fake
        delete cur[last];
      }
      return state;
    },
    async listPaths() {
      return flattenLeafPaths(state);
    },
  };
}

describe("config tools", () => {
  it("get_config returns the whole tree when no path", async () => {
    const backend = fakeBackend({ server: { port: 8080 } });
    const tool = new GetConfigTool(backend);
    const res = await tool.run({}, { cwd: "/" });
    const payload = JSON.parse(res.result as string);
    expect(payload.config).toEqual({ server: { port: 8080 } });
  });

  it("get_config returns a scalar at a path", async () => {
    const backend = fakeBackend({ server: { port: 8080 } });
    const tool = new GetConfigTool(backend);
    const res = await tool.run({ path: "server.port" }, { cwd: "/" });
    const payload = JSON.parse(res.result as string);
    expect(payload).toEqual({ path: "server.port", value: 8080 });
  });

  it("get_config indexes into arrays with numeric segments", async () => {
    const backend = fakeBackend({ auth: { tokens: [{ label: "dash", scopes: ["*"] }] } });
    const tool = new GetConfigTool(backend);
    const res = await tool.run({ path: "auth.tokens.0.label" }, { cwd: "/" });
    const payload = JSON.parse(res.result as string);
    expect(payload.value).toBe("dash");
  });

  it("set_config writes through to the backend", async () => {
    const backend = fakeBackend({ server: { port: 8080 } });
    const tool = new SetConfigTool(backend);
    await tool.run({ path: "server.port", value: 9090 }, { cwd: "/" });
    expect(backend.setCalls).toEqual([{ path: "server.port", value: 9090 }]);
    expect(backend.state).toEqual({ server: { port: 9090 } });
  });

  it("set_config accepts complex values (objects, arrays)", async () => {
    const backend = fakeBackend({ auth: { tokens: [] } });
    const tool = new SetConfigTool(backend);
    await tool.run(
      {
        path: "auth.tokens",
        value: [{ label: "bot", key_env: "BOT_TOKEN", scopes: ["chat.*"] }],
      },
      { cwd: "/" },
    );
    expect(backend.state).toMatchObject({
      auth: { tokens: [{ label: "bot", scopes: ["chat.*"] }] },
    });
  });

  it("unset_config removes a key and returns the new tree", async () => {
    const backend = fakeBackend({ llm: { primary: { model: "claude-sonnet-4-5" }, foo: "bar" } });
    const tool = new UnsetConfigTool(backend);
    const res = await tool.run({ path: "llm.foo" }, { cwd: "/" });
    const payload = JSON.parse(res.result as string);
    expect(payload.removed).toBe("llm.foo");
    expect(backend.state).toEqual({ llm: { primary: { model: "claude-sonnet-4-5" } } });
  });

  it("list_config_paths flattens nested objects and arrays to leaf paths", async () => {
    const backend = fakeBackend({
      server: { port: 8080, host: "0.0.0.0" },
      auth: { tokens: [{ label: "dash", scopes: ["*"] }] },
    });
    const tool = new ListConfigPathsTool(backend);
    const res = await tool.run({}, { cwd: "/" });
    const payload = JSON.parse(res.result as string);
    expect(payload.paths).toEqual(
      expect.arrayContaining([
        "server.port",
        "server.host",
        "auth.tokens.0.label",
        "auth.tokens.0.scopes.0",
      ]),
    );
  });

  it("registerConfigTools registers all four tools", () => {
    const registry = new ToolRegistry();
    const backend = fakeBackend({});
    registerConfigTools(registry, backend);
    expect(registry.names().sort()).toEqual(
      ["get_config", "list_config_paths", "set_config", "unset_config"].sort(),
    );
  });

  it("write tools are tagged `write`, read tools are tagged `readonly`", () => {
    const backend = fakeBackend({});
    expect(new GetConfigTool(backend).tags).toContain("readonly");
    expect(new ListConfigPathsTool(backend).tags).toContain("readonly");
    expect(new SetConfigTool(backend).tags).toContain("write");
    expect(new UnsetConfigTool(backend).tags).toContain("write");
  });
});

describe("splitPath / flattenLeafPaths", () => {
  it("splitPath treats numeric segments as array indices", () => {
    expect(splitPath("auth.tokens.0.scopes.1")).toEqual([
      "auth", "tokens", 0, "scopes", 1,
    ]);
  });

  it("splitPath returns [] for empty string", () => {
    expect(splitPath("")).toEqual([]);
  });

  it("flattenLeafPaths emits a path for an empty object", () => {
    expect(flattenLeafPaths({ a: {} })).toEqual(["a"]);
  });

  it("flattenLeafPaths emits a path for an empty array", () => {
    expect(flattenLeafPaths({ a: [] })).toEqual(["a"]);
  });
});
