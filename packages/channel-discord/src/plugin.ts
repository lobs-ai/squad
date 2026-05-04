import { definePlugin, PROMPT_SLOTS } from "@squad/plugin-sdk";
import { CarbonDiscordBackend } from "./backend.js";
import { DiscordChannel } from "./channel.js";
import { discordConfigSchema } from "./config.js";
import { discordGroup, registerDiscordTools } from "./tools/index.js";

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
    // Contribute the discord tool group + its executors. The group makes the
    // tools lazy-loadable (agents must call describe_tool_group({groups:
    // "discord"}) to see schemas); the executors resolve the live bot lazily
    // because tools are wired at register time but the bot only connects
    // after the gateway fires `start()`.
    api.toolGroups.register(discordGroup);
    const backend = new CarbonDiscordBackend(() => {
      const bot = channel.getBot();
      if (!bot) throw new Error("discord channel not connected yet");
      return bot;
    }, botLogger);
    registerDiscordTools(api.tools, backend);
    api.delivery.register(
      "discord",
      async (ctx) => {
        const delivery = ctx.delivery as { kind: "discord"; channelId?: string; guildId?: string };
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
      },
      {
        description:
          "Posts the run output into a Discord channel. Pass channelId (snowflake) under `extras`.",
        extrasSchema: {
          channelId: { type: "string", description: "Discord channel snowflake (required)" },
          guildId: { type: "string", description: "Optional guild id" },
        },
      },
    );

    // ── Conditional prompt fragments ────────────────────────────────────
    // Each fragment changes a specific tool-call decision the agent would
    // otherwise get wrong. Render-conditional ones (`when` predicate) only
    // appear in turns rendering for a Discord channel — dashboard / CLI
    // turns never see them.
    const isDiscordTurn = (render: { surface?: string; channelKind?: string }) =>
      render.surface === "channel" && render.channelKind === "discord";

    api.promptFragments.register({
      slot: PROMPT_SLOTS.CRON_DELIVERY_HANDLERS,
      content:
        'discord — post into a guild channel. Required: channelId (snowflake). ' +
        'Example: { kind: "discord", channelId: "1234567890123456" }',
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.DELIVERY_SILENT_GATE,
      content: "discord delivery honors [SILENT] — first-line wake gate suppresses the post.",
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.CRON_DELIVERY_DEFAULT,
      content: "post the result back to this Discord channel unless told otherwise",
      when: (render) => isDiscordTurn(render),
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.ASK_USER_CHANNEL_CAPABILITIES,
      content:
        "Discord buttons cap at 4 options; option labels truncate at 80 chars. " +
        "preview text renders in a markdown code block — use ASCII layouts, not images.",
      when: (render) => isDiscordTurn(render),
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.ASK_USER_ESCALATION_TARGET,
      content:
        "ask_user delivered here renders inline in the same Discord thread. " +
        "Don't redirect to the dashboard — the user is reading Discord.",
      when: (render) => isDiscordTurn(render),
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.ASK_USER_PREVIEW_RENDERING,
      content:
        "Discord renders option.preview as a fenced code block — works for diffs, " +
        "config snippets, ASCII tables. Avoid wide tables (>80 cols wrap badly).",
      when: (render) => isDiscordTurn(render),
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
  payloadKind: "prompt" | "script" | "scriptThenPrompt";
  output?: string;
}): string {
  const head = `**${ctx.routineName}** (${ctx.payloadKind})`;
  const body = (ctx.output ?? "").trim();
  if (!body) return `${head}\n_(no output)_`;
  return `${head}\n${body}`;
}
