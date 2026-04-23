import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonConfigBackend } from "./config-backend.js";
import type { Config } from "./config.js";

const BASE = {
  server: { host: "0.0.0.0", port: 8080, data_dir: "./data" },
  auth: {
    tokens: [{ label: "dashboard", key_env: "SQUAD_DASHBOARD_TOKEN", scopes: ["*"] }],
  },
  chat: { delivery: "interrupt" },
  llm: {
    primary: { model: "claude-sonnet-4-5" },
    fallbacks: [{ model: "openai/gpt-4o" }],
    providers: { anthropic: { api_key_env: "ANTHROPIC_API_KEY" } },
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
  plugins: [],
  channels: {},
};

describe("JsonConfigBackend", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "squad-cfg-backend-"));
    path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify(BASE, null, 2), "utf8");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("get() returns the parsed JSON", async () => {
    const b = new JsonConfigBackend({ path });
    const cfg = await b.get();
    expect((cfg as { server: { port: number } }).server.port).toBe(8080);
  });

  it("getValue() reads a scalar by dot path", async () => {
    const b = new JsonConfigBackend({ path });
    expect(await b.getValue("llm.primary.model")).toBe("claude-sonnet-4-5");
    expect(await b.getValue("subagents.max_concurrent_global")).toBe(8);
  });

  it("getValue() indexes into arrays with numeric segments", async () => {
    const b = new JsonConfigBackend({ path });
    expect(await b.getValue("auth.tokens.0.label")).toBe("dashboard");
    expect(await b.getValue("policy.approvals.require_for_tags.0")).toBe("write");
    expect(await b.getValue("llm.fallbacks.0.model")).toBe("openai/gpt-4o");
  });

  it("getValue() returns undefined for missing paths", async () => {
    const b = new JsonConfigBackend({ path });
    expect(await b.getValue("does.not.exist")).toBeUndefined();
    expect(await b.getValue("auth.tokens.99")).toBeUndefined();
  });

  it("setValue() persists to disk and round-trips", async () => {
    const b = new JsonConfigBackend({ path });
    await b.setValue("llm.primary.model", "claude-haiku-4-5");
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.llm.primary.model).toBe("claude-haiku-4-5");
    // Unrelated keys preserved.
    expect(after.auth.tokens[0].label).toBe("dashboard");
  });

  it("setValue() fires onUpdate with the validated Config", async () => {
    let latest: Config | undefined;
    const b = new JsonConfigBackend({
      path,
      onUpdate: (cfg) => {
        latest = cfg;
      },
    });
    await b.setValue("server.port", 9090);
    expect(latest?.server.port).toBe(9090);
    // And the rest of the shape came through zod defaults intact.
    expect(latest?.chat.delivery.mode).toBe("interrupt");
  });

  it("setValue() rejects invalid values without touching the file", async () => {
    const original = readFileSync(path, "utf8");
    const b = new JsonConfigBackend({ path });
    await expect(b.setValue("chat.delivery", "blast")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("setValue() creates missing intermediate keys", async () => {
    const b = new JsonConfigBackend({ path });
    await b.setValue("channels.discord.guild_id", "abc123");
    const cfg = await b.get();
    expect(cfg).toMatchObject({ channels: { discord: { guild_id: "abc123" } } });
  });

  it("setValue() can set a whole array", async () => {
    const b = new JsonConfigBackend({ path });
    await b.setValue("policy.approvals.require_for_tags", ["write"]);
    expect(await b.getValue("policy.approvals.require_for_tags")).toEqual(["write"]);
  });

  it("setValue() can set an object into an array element", async () => {
    const b = new JsonConfigBackend({ path });
    await b.setValue("auth.tokens.1", {
      label: "bot",
      key_env: "BOT_TOKEN",
      scopes: ["chat.*"],
    });
    expect(await b.getValue("auth.tokens.1.label")).toBe("bot");
    expect(await b.getValue("auth.tokens.0.label")).toBe("dashboard");
  });

  it("setValue() can append a fallback", async () => {
    const b = new JsonConfigBackend({ path });
    await b.setValue("llm.fallbacks.1", { model: "google/gemini-2.0-flash" });
    expect(await b.getValue("llm.fallbacks.1.model")).toBe("google/gemini-2.0-flash");
    expect(await b.getValue("llm.fallbacks.0.model")).toBe("openai/gpt-4o");
  });

  it("setValue() rejects empty path", async () => {
    const b = new JsonConfigBackend({ path });
    await expect(b.setValue("", 1)).rejects.toThrow(/non-empty/);
  });

  it("unsetValue() removes a key and validates the result", async () => {
    const b = new JsonConfigBackend({ path });
    await b.unsetValue("llm.providers.anthropic");
    expect(await b.getValue("llm.providers.anthropic")).toBeUndefined();
    expect(await b.getValue("llm.primary.model")).toBe("claude-sonnet-4-5");
  });

  it("unsetValue() removes an array element and shifts indices", async () => {
    const b = new JsonConfigBackend({ path });
    await b.setValue("llm.fallbacks.1", { model: "google/gemini-2.0-flash" });
    await b.unsetValue("llm.fallbacks.0");
    expect(await b.getValue("llm.fallbacks.0.model")).toBe("google/gemini-2.0-flash");
    expect(await b.getValue("llm.fallbacks.1")).toBeUndefined();
  });

  it("unsetValue() throws for a path that doesn't exist", async () => {
    const b = new JsonConfigBackend({ path });
    await expect(b.unsetValue("does.not.exist")).rejects.toThrow(/is not set/);
  });

  it("unsetValue() rejects empty path", async () => {
    const b = new JsonConfigBackend({ path });
    await expect(b.unsetValue("")).rejects.toThrow(/non-empty/);
  });

  it("listPaths() emits dot-paths to every leaf", async () => {
    const b = new JsonConfigBackend({ path });
    const paths = await b.listPaths();
    expect(paths).toEqual(
      expect.arrayContaining([
        "server.host",
        "server.port",
        "server.data_dir",
        "auth.tokens.0.label",
        "auth.tokens.0.scopes.0",
        "chat.delivery",
        "llm.primary.model",
        "llm.fallbacks.0.model",
        "subagents.max_concurrent_global",
        "policy.approvals.default",
      ]),
    );
  });
});
