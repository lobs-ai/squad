import { describe, it, expect } from "vitest";
import discordPlugin from "./plugin.js";
import type {
  ChannelHandle,
  GatewayAPI,
  SkillDescriptor,
} from "@squad/plugin-sdk";

/**
 * Smoke test for the Discord plugin wrapper. We don't exercise real Discord
 * or real WebSocket traffic — we hand the plugin a fake GatewayAPI and check
 * that it registers a channel with id "discord" and exposes start/stop. The
 * full connect() path is covered indirectly through the `DiscordChannel`
 * tests (config resolution) and the gateway integration tests (lifecycle).
 */
function makeFakeApi(config: Record<string, unknown>): {
  api: GatewayAPI;
  channels: ChannelHandle[];
  skills: SkillDescriptor[];
  logs: string[];
} {
  const channels: ChannelHandle[] = [];
  const skills: SkillDescriptor[] = [];
  const logs: string[] = [];
  const noop = (): void => {};
  const api: GatewayAPI = {
    tools: { register: noop },
    providers: { register: noop },
    subagents: { register: noop },
    routines: { register: noop },
    skills: { register: (s) => void skills.push(s) },
    approvalPolicies: { register: noop },
    channels: { register: (c) => void channels.push(c) },
    logger: {
      info: (msg) => logs.push(`info:${msg}`),
      warn: (msg) => logs.push(`warn:${msg}`),
      error: (msg) => logs.push(`error:${msg}`),
    },
    config,
  };
  return { api, channels, skills, logs };
}

describe("discord plugin", () => {
  it("registers a discord channel with start/stop handles", async () => {
    const { api, channels, logs } = makeFakeApi({
      bot_token_env: "DISCORD_BOT_TOKEN_TEST",
      gateway_token: "gw-test",
      gateway_url: "ws://127.0.0.1:65535/ws",
    });

    await discordPlugin.register(api);

    expect(channels).toHaveLength(1);
    const channel = channels[0]!;
    expect(channel.id).toBe("discord");
    expect(typeof channel.start).toBe("function");
    expect(typeof channel.stop).toBe("function");
    expect(logs).toContain("info:discord channel plugin registered");
  });

  it("declares itself as a channel kind so the host can route it", () => {
    expect(discordPlugin.kinds).toContain("channel");
    expect(discordPlugin.id).toBe("channel-discord");
  });

  it("throws during register if the gateway token is missing", () => {
    const { api } = makeFakeApi({
      bot_token_env: "DISCORD_BOT_TOKEN_TEST",
      // no gateway_token or gateway_token_env — resolveGatewayToken must fail
    });
    expect(() => discordPlugin.register(api)).toThrow(/gateway/i);
  });
});
