import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configSchema, loadConfig, resolveTokenSecrets, type Config } from "./config.js";

describe("config.chat.delivery parsing", () => {
  it("defaults to interrupt when chat is omitted", () => {
    const c = configSchema.parse({});
    expect(c.chat.delivery.mode).toBe("interrupt");
    expect(c.chat.delivery.max_queued).toBe(50);
    expect(c.chat.delivery.collapse_duplicates).toBe(true);
  });

  it("accepts shorthand: chat.delivery as a string", () => {
    const c = configSchema.parse({ chat: { delivery: "queue" } });
    expect(c.chat.delivery.mode).toBe("queue");
    expect(c.chat.delivery.max_queued).toBe(50);
  });

  it("accepts shorthand: chat.delivery_mode as a string", () => {
    const c = configSchema.parse({ chat: { delivery_mode: "queue" } });
    expect(c.chat.delivery.mode).toBe("queue");
  });

  it("accepts full object form with tuning knobs", () => {
    const c = configSchema.parse({
      chat: {
        delivery: {
          mode: "queue",
          max_queued: 10,
          collapse_duplicates: false,
        },
      },
    });
    expect(c.chat.delivery.mode).toBe("queue");
    expect(c.chat.delivery.max_queued).toBe(10);
    expect(c.chat.delivery.collapse_duplicates).toBe(false);
  });

  it("rejects unknown delivery modes with a readable error", () => {
    expect(() => configSchema.parse({ chat: { delivery: "blast" } })).toThrow();
  });

  it("rejects max_queued > 1000", () => {
    expect(() =>
      configSchema.parse({ chat: { delivery: { max_queued: 10_000 } } }),
    ).toThrow();
  });
});

describe("config.llm primary/fallbacks parsing", () => {
  it("defaults primary to claude-sonnet-4-5 with no fallbacks", () => {
    const c = configSchema.parse({});
    expect(c.llm.primary.model).toBe("claude-sonnet-4-5");
    expect(c.llm.fallbacks).toEqual([]);
    expect(c.llm.providers).toEqual({});
  });

  it("accepts primary as a bare string", () => {
    const c = configSchema.parse({ llm: { primary: "openai/gpt-4o" } });
    expect(c.llm.primary.model).toBe("openai/gpt-4o");
  });

  it("accepts primary as an object", () => {
    const c = configSchema.parse({ llm: { primary: { model: "openai/gpt-4o" } } });
    expect(c.llm.primary.model).toBe("openai/gpt-4o");
  });

  it("accepts fallbacks as a mix of strings and objects", () => {
    const c = configSchema.parse({
      llm: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o", { model: "google/gemini-2.0-flash" }],
      },
    });
    expect(c.llm.fallbacks.map((f) => f.model)).toEqual([
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
    ]);
  });

  it("rejects empty primary model string", () => {
    expect(() => configSchema.parse({ llm: { primary: "" } })).toThrow();
    expect(() => configSchema.parse({ llm: { primary: { model: "" } } })).toThrow();
  });
});

describe("loadConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "squad-config-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns all defaults when path is undefined", () => {
    const c = loadConfig(undefined);
    expect(c.server.port).toBe(8080);
    expect(c.llm.primary.model).toBe("claude-sonnet-4-5");
    expect(c.llm.fallbacks).toEqual([]);
    expect(c.plugins).toEqual([]);
  });

  it("reads a JSON file and merges with defaults", () => {
    const path = join(tmp, "c.json");
    writeFileSync(
      path,
      JSON.stringify({
        server: { port: 9999 },
        llm: {
          primary: "anthropic/claude-haiku-4-5",
          fallbacks: ["openai/gpt-4o-mini"],
        },
      }),
    );
    const c = loadConfig(path);
    expect(c.server.port).toBe(9999);
    expect(c.server.data_dir).toBe("./data"); // default still applied
    expect(c.llm.primary.model).toBe("anthropic/claude-haiku-4-5");
    expect(c.llm.fallbacks[0]?.model).toBe("openai/gpt-4o-mini");
  });

  it("treats an empty JSON file as {}", () => {
    const path = join(tmp, "c.json");
    writeFileSync(path, "");
    const c = loadConfig(path);
    expect(c.server.port).toBe(8080);
  });

  it("rejects malformed JSON", () => {
    const path = join(tmp, "c.json");
    writeFileSync(path, "{ oops");
    expect(() => loadConfig(path)).toThrow();
  });
});

describe("resolveTokenSecrets", () => {
  const base = (
    tokens: Config["auth"]["tokens"],
  ): Config => configSchema.parse({ auth: { tokens } });

  it("passes literal keys through unchanged", () => {
    const c = base([{ label: "cli", key: "literal-secret", scopes: ["*"] }]);
    expect(resolveTokenSecrets(c)).toEqual([
      { label: "cli", secret: "literal-secret", scopes: ["*"] },
    ]);
  });

  it("reads from the environment when key_env is set", () => {
    const orig = process.env.SQUAD_TEST_TOKEN;
    process.env.SQUAD_TEST_TOKEN = "from-env";
    try {
      const c = base([
        { label: "cli", key_env: "SQUAD_TEST_TOKEN", scopes: ["chat.*"] },
      ]);
      expect(resolveTokenSecrets(c)).toEqual([
        { label: "cli", secret: "from-env", scopes: ["chat.*"] },
      ]);
    } finally {
      if (orig === undefined) delete process.env.SQUAD_TEST_TOKEN;
      else process.env.SQUAD_TEST_TOKEN = orig;
    }
  });

  it("throws with the env var name when the secret is missing", () => {
    delete process.env.SQUAD_MISSING_TOKEN;
    const c = base([{ label: "cli", key_env: "SQUAD_MISSING_TOKEN", scopes: ["*"] }]);
    expect(() => resolveTokenSecrets(c)).toThrow(/SQUAD_MISSING_TOKEN/);
  });

  it("throws when neither key nor key_env is set", () => {
    const c = base([{ label: "cli", scopes: ["*"] }]);
    expect(() => resolveTokenSecrets(c)).toThrow(/no secret/);
  });
});
