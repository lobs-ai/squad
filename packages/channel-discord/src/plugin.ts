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
    const channel = new DiscordChannel({ config: cfg });
    api.channels.register({
      id: channel.id,
      start: () => channel.connect(),
      stop: () => channel.disconnect(),
    });
    api.logger.info("discord channel plugin registered");
  },
});
