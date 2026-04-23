import { describe, it, expect, afterEach } from "vitest";
import {
  discordConfigSchema,
  bindingSchema,
  resolveBotToken,
  resolveGatewayToken,
  type DiscordConfig,
} from "./config.js";

function parse(overrides: Record<string, unknown> = {}): DiscordConfig {
  return discordConfigSchema.parse(overrides);
}

describe("discordConfigSchema", () => {
  it("applies defaults when no fields are set", () => {
    const c = parse();
    expect(c.bot_token_env).toBe("DISCORD_BOT_TOKEN");
    expect(c.gateway_url).toBe("ws://127.0.0.1:8080/ws");
    expect(c.bindings).toEqual([]);
    expect(c.approval_tags).toEqual(["write", "exec", "network"]);
    expect(c.max_message_length).toBe(1900);
    expect(c.stream_edits).toBe(true);
  });

  it("rejects invalid max_message_length values", () => {
    expect(() => parse({ max_message_length: 0 })).toThrow();
    expect(() => parse({ max_message_length: -10 })).toThrow();
    expect(() => parse({ max_message_length: 1.5 })).toThrow();
  });

  it("accepts guild + channel bindings and DM bindings", () => {
    const c = parse({
      bindings: [{ guild_id: "g", channel_id: "c" }, { dm: true }],
    });
    expect(c.bindings).toEqual([
      { guild_id: "g", channel_id: "c" },
      { dm: true },
    ]);
  });
});

describe("bindingSchema", () => {
  it("requires guild_id + channel_id for non-DM bindings", () => {
    expect(() => bindingSchema.parse({ guild_id: "g" })).toThrow();
    expect(bindingSchema.parse({ guild_id: "g", channel_id: "c" })).toEqual({
      guild_id: "g",
      channel_id: "c",
    });
  });

  it("requires dm to be literally true", () => {
    expect(() => bindingSchema.parse({ dm: false })).toThrow();
    expect(bindingSchema.parse({ dm: true })).toEqual({ dm: true });
  });
});

describe("resolveBotToken", () => {
  const key = "SQUAD_TEST_DISCORD_TOKEN";
  afterEach(() => delete process.env[key]);

  it("reads the configured env var", () => {
    process.env[key] = "tok";
    const c = parse({ bot_token_env: key });
    expect(resolveBotToken(c)).toBe("tok");
  });

  it("throws with the env var name when unset", () => {
    const c = parse({ bot_token_env: key });
    expect(() => resolveBotToken(c)).toThrow(new RegExp(key));
  });
});

describe("resolveGatewayToken", () => {
  const key = "SQUAD_TEST_GW_TOKEN";
  afterEach(() => delete process.env[key]);

  it("prefers the literal gateway_token over the env var", () => {
    process.env[key] = "from-env";
    const c = parse({ gateway_token: "literal", gateway_token_env: key });
    expect(resolveGatewayToken(c)).toBe("literal");
  });

  it("falls back to the env var when no literal is set", () => {
    process.env[key] = "from-env";
    const c = parse({ gateway_token_env: key });
    expect(resolveGatewayToken(c)).toBe("from-env");
  });

  it("throws when neither source is available", () => {
    const c = parse({ gateway_token_env: key });
    expect(() => resolveGatewayToken(c)).toThrow(/Gateway token missing/);
  });
});
