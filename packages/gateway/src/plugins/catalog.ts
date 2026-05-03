import { z, type ZodTypeAny } from "zod";
import { pluginField } from "@squad/plugin-sdk";
import type { PluginKind } from "@squad/protocol";

/**
 * A plugin shipped inside the squad workspace. The dashboard and CLI surface
 * these as a curated list so users can enable/disable them with one click
 * instead of hand-editing `config.plugins[]` paths.
 *
 * `source` is what we hand to the plugin host; it's relative to the gateway's
 * cwd (which is `packages/gateway` in both docker and local modes — same
 * convention `scripts/setup.mjs` uses for the Discord plugin).
 *
 * External plugins (npm specifiers, third-party paths) are not in the
 * catalog; users still install those by editing config.plugins directly.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  kinds: PluginKind[];
  /** Default config seeded into the entry when first installed. */
  defaultConfig?: Record<string, unknown>;
  /** Other catalog ids that must be installed first. */
  requires?: string[];
  /**
   * Optional Zod schema for the plugin's config. When present:
   *  - the dashboard / CLI render a configure form before install,
   *  - the gateway validates user input on install,
   *  - any field tagged `pluginField(..., { secret: true, autoGenerate: true })`
   *    gets a 32-byte hex token written into config when the user leaves it
   *    blank.
   *
   * The schema lives on the catalog entry (not the plugin descriptor) on
   * purpose: external plugins authored before this feature don't need to
   * change, and the gateway can publish the schema for them in the catalog.
   */
  configSchema?: ZodTypeAny;
  /**
   * Set when the plugin needs to authenticate back to the gateway over its
   * own WebSocket — the install path generates an `auth.tokens[]` entry and
   * stores the matching value in the plugin's config under `tokenConfigKey`.
   * Uninstall removes the token entry.
   */
  needsAuthToken?: {
    /** Label written to `auth.tokens[].label` (defaults to the plugin id). */
    label?: string;
    /** Scopes assigned to the generated token (defaults to ["*"]). */
    scopes?: string[];
    /** Plugin config key that holds the literal token value. */
    tokenConfigKey: string;
  };
  /**
   * Plain-prose walkthrough the agent reads when the user kicks off
   * "setup with agent" from the dashboard. Should describe every step the
   * user needs to take *outside* this app to gather the values the install
   * form requires (e.g. "open discord.com/developers, …"). The agent
   * paraphrases this — there's no requirement that it be markdown-formatted
   * or read verbatim.
   */
  setupPlaybook?: string;
  /**
   * External secrets the plugin reads from `process.env`. Listed here so
   * the configure form can collect them as password inputs and the install
   * path can persist them to the local secret store under the named env
   * var. Plugins keep using `process.env[envVar]` unchanged — the boot-
   * time `SecretStore.mergeIntoProcessEnv` populates them.
   *
   * Why this isn't part of `configSchema`: secrets are conceptually
   * different from config — they live in a separate file (mode 0600), are
   * never written to `config.plugins[].config`, and are removed by
   * `plugins.uninstall`. Modeling them as schema fields would have meant
   * either polluting the saved config with secret values or building a
   * special-case "this field is a secret with this env binding" inside Zod.
   */
  secrets?: CatalogSecret[];
}

export interface CatalogSecret {
  /** Env var the plugin reads at runtime (e.g. "DISCORD_BOT_TOKEN"). */
  envVar: string;
  /** Display label for the form. Defaults to the envVar in title case. */
  label?: string;
  /** True when the plugin won't function without it. */
  required?: boolean;
  /** One-line guidance shown under the field (e.g. "From discord.com/developers"). */
  hint?: string;
}

export const PREINSTALLED_PLUGINS: readonly CatalogEntry[] = [
  {
    // Matches the descriptor id in packages/channel-discord/src/plugin.ts.
    // The catalog id MUST equal the runtime descriptor id (not the npm
    // package name) — host.recordFor / records() key on descriptor id.
    id: "channel-discord",
    name: "Discord",
    description: "First-party Discord channel — DMs, slash commands, threads.",
    source: "../channel-discord/dist/plugin.js",
    kinds: ["channel"],
    defaultConfig: {
      bot_token_env: "DISCORD_BOT_TOKEN",
      gateway_url: "ws://127.0.0.1:8080/ws",
      dm_policy: "allow_list",
      dm_allow_list: [],
      bindings: [],
    },
    needsAuthToken: {
      label: "discord-bot",
      scopes: ["*"],
      tokenConfigKey: "gateway_token",
    },
    secrets: [
      {
        envVar: "DISCORD_BOT_TOKEN",
        label: "Discord bot token",
        required: true,
        hint: "From the Discord developer portal → your application → Bot → Reset Token. Stored locally and never written to config.json.",
      },
    ],
    setupPlaybook: [
      "Goal: get the Discord plugin installed and the bot replying in a guild channel.",
      "",
      "Step 1 — Create a Discord application.",
      "  - Open https://discord.com/developers/applications and click 'New Application'.",
      "  - Name it whatever (the user decides).",
      "  - In the left sidebar, click 'Bot'. Scroll down and enable",
      "    'MESSAGE CONTENT INTENT' — without it the bot can't read messages.",
      "  - Click 'Reset Token' (or 'Copy' if a token is already shown). Save the",
      "    bot token somewhere safe — Discord only reveals it once.",
      "",
      "Step 2 — Decide where the token will live in this gateway.",
      "  - The plugin reads its bot token from an env var. The user's existing",
      "    `.env` file (or container env) needs an entry like",
      "    `DISCORD_BOT_TOKEN=<the token from step 1>`.",
      "  - The schema field `bot_token_env` is the *name* of the env var, not",
      "    the token itself. Default is 'DISCORD_BOT_TOKEN'.",
      "",
      "Step 3 — Invite the bot into a guild.",
      "  - Back on the developer portal, go to 'OAuth2' → 'URL Generator'.",
      "  - Under 'Scopes' check `bot` and `applications.commands`.",
      "  - Under 'Bot Permissions' at minimum: Send Messages, Read Message",
      "    History, Use Slash Commands. (More if you want it doing more.)",
      "  - Copy the generated URL, open it in a browser, pick a guild, authorize.",
      "",
      "Step 4 — Find the guild + channel ids you want it to reply in.",
      "  - In Discord client, enable Developer Mode (User Settings → Advanced).",
      "  - Right-click the guild icon → 'Copy Guild ID'.",
      "  - Right-click the channel → 'Copy Channel ID'.",
      "  - These go into `bindings: [{ guild_id: '...', channel_id: '...' }]`.",
      "    Multiple bindings = bot replies in all of them.",
      "",
      "Step 5 — DMs (optional).",
      "  - `dm_policy` controls direct messages. 'allow_list' (default) means",
      "    only specific Discord user ids can DM the bot — safer for shared",
      "    bots. 'open' = anyone, 'blocked' = no one.",
      "  - If using 'allow_list', collect the user's Discord user ids the same",
      "    way (right-click profile → Copy User ID) and put them in",
      "    `dm_allow_list`.",
      "",
      "Step 6 — Install.",
      "  - Once you have all the values, call `plugin_install` with",
      "    id='channel-discord' and the gathered config.",
      "  - `gateway_token` will be auto-generated — leave it out of your call.",
      "  - If install errors with `missing_config`, the error tells you which",
      "    field is wrong; ask the user for it and retry.",
      "  - After install, ask the user to confirm the bot replied to a test",
      "    message in their guild, and confirm they exported DISCORD_BOT_TOKEN",
      "    in the gateway's environment (or restarted the container after",
      "    setting it).",
    ].join("\n"),
    configSchema: z.object({
      bot_token_env: z
        .string()
        .describe(
          "Name of the env var that holds your Discord bot token (e.g. DISCORD_BOT_TOKEN).",
        )
        .default("DISCORD_BOT_TOKEN"),
      gateway_url: z
        .string()
        .describe("WebSocket URL the bot uses to talk back to this gateway.")
        .default("ws://127.0.0.1:8080/ws"),
      gateway_token: pluginField(
        z
          .string()
          .describe(
            "Auto-generated token used by the bot to authenticate to this gateway. Leave blank to generate.",
          )
          .optional(),
        { secret: true, autoGenerate: true },
      ),
      dm_policy: z
        .enum(["allow_list", "open", "blocked"])
        .describe(
          "How DMs are handled. allow_list = only listed user ids; open = anyone; blocked = none.",
        )
        .default("allow_list"),
      dm_allow_list: z
        .array(z.string())
        .describe("Discord user ids (snowflakes) allowed to DM the bot under allow_list.")
        .default([]),
      bindings: z
        .array(z.object({ guild_id: z.string(), channel_id: z.string() }))
        .describe("Guild/channel pairs the bot replies in. Empty = none.")
        .default([]),
    }),
  },
  {
    id: "@squad/plugin-google-auth",
    name: "Google OAuth",
    description: "Shared Google OAuth + token storage for Calendar/Gmail/Drive.",
    source: "../plugin-google-auth/dist/plugin.js",
    kinds: ["tool"],
  },
  {
    id: "@squad/plugin-gmail",
    name: "Gmail",
    description: "Gmail tools — search, read, send, label.",
    source: "../plugin-gmail/dist/plugin.js",
    kinds: ["tool"],
    requires: ["@squad/plugin-google-auth"],
  },
  {
    id: "@squad/plugin-google-calendar",
    name: "Google Calendar",
    description: "Calendar tools — list, create, update, delete, RSVP.",
    source: "../plugin-google-calendar/dist/plugin.js",
    kinds: ["tool"],
    requires: ["@squad/plugin-google-auth"],
  },
  {
    id: "@squad/plugin-google-drive",
    name: "Google Drive",
    description: "Drive tools — search, list, read.",
    source: "../plugin-google-drive/dist/plugin.js",
    kinds: ["tool"],
    requires: ["@squad/plugin-google-auth"],
  },
];

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return PREINSTALLED_PLUGINS.find((p) => p.id === id);
}
