import { definePlugin } from "@squad/plugin-sdk";
import { DiscordChannel } from "./channel.js";
import { discordConfigSchema } from "./config.js";

/**
 * Discord-as-a-plugin. The gateway has no Discord-specific code; this plugin
 * connects back to the gateway over WebSocket (via `SquadGatewayClient`
 * inside `DiscordChannel`) and logs into Discord with the configured bot
 * token. Point `config.plugins` at this module and pass the Discord config
 * in the `config` field of the plugin entry:
 *
 *   {
 *     "plugins": [
 *       {
 *         "path": "../channel-discord/dist/plugin.js",
 *         "config": {
 *           "bot_token_env": "DISCORD_BOT_TOKEN",
 *           "gateway_token_env": "SQUAD_DISCORD_TOKEN",
 *           "gateway_url": "ws://127.0.0.1:8080/ws"
 *         }
 *       }
 *     ]
 *   }
 *
 * The path is resolved against the gateway's cwd (`packages/gateway/`).
 * Absolute paths work too, and bare module specifiers are attempted through
 * Node's resolver for plugins that live in `node_modules`.
 */
export default definePlugin({
  id: "channel-discord",
  name: "Discord channel",
  version: "0.0.1",
  kinds: ["channel"],
  register(api) {
    const cfg = discordConfigSchema.parse(api.config);
    // Adapt the GatewayAPI logger (msg, meta) to the bot's (meta, msg) shape.
    const botLogger = {
      info: (meta: Record<string, unknown>, msg: string) => api.logger.info(msg, meta),
      warn: (meta: Record<string, unknown>, msg: string) => api.logger.warn(msg, meta),
      error: (meta: Record<string, unknown>, msg: string) => api.logger.error(msg, meta),
    };
    const channel = new DiscordChannel({ config: cfg, logger: botLogger });
    api.channels.register({
      id: channel.id,
      kind: "discord",
      label: "Discord",
      start: () => channel.connect(),
      stop: () => channel.disconnect(),
    });
    api.delivery.register("discord", async (ctx) => {
      const delivery = ctx.delivery as { kind: "discord"; channelId: string; guildId?: string };
      if (!delivery.channelId) {
        return { ok: false, error: "discord delivery missing channelId" };
      }
      const text = formatRoutineDelivery(ctx);
      try {
        await channel.sendToChannel(delivery.channelId, text);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    api.logger.info("discord channel plugin registered", {
      dm_policy: cfg.dm_policy,
      dm_allow_list_size: cfg.dm_allow_list.length,
      bindings: cfg.bindings.length,
    });
  },
});

/** Compose the body of a routine fire for posting into a Discord channel. */
function formatRoutineDelivery(ctx: {
  routineName: string;
  payloadKind: "prompt" | "agentTurn" | "script";
  output?: string;
}): string {
  const head = `**${ctx.routineName}** (${ctx.payloadKind})`;
  const body = (ctx.output ?? "").trim();
  if (!body) return `${head}\n_(no output)_`;
  return `${head}\n${body}`;
}
