import { z } from "zod";

/**
 * Guild-channel binding. The bot always replies in channels that match any
 * of these bindings. DMs are gated separately through `dm_policy`.
 */
export const bindingSchema = z.object({
  guild_id: z.string(),
  channel_id: z.string(),
});

/**
 * How the bot treats direct messages.
 *
 * - "allow_list" (default): DMs are honored only from user IDs in
 *   `dm_allow_list`. This is the safe default — a leaked bot token can't be
 *   used to talk to the agent from an arbitrary Discord account.
 * - "open": any user can DM the bot. Useful for public assistants or local
 *   single-user setups.
 * - "blocked": DMs are never answered. The bot still works in bound guild
 *   channels.
 */
export const dmPolicySchema = z.enum(["allow_list", "open", "blocked"]);
export type DmPolicy = z.infer<typeof dmPolicySchema>;

export const discordConfigSchema = z.object({
  bot_token_env: z.string().default("DISCORD_BOT_TOKEN"),
  gateway_url: z.string().default("ws://127.0.0.1:8080/ws"),
  gateway_token_env: z.string().optional(),
  gateway_token: z.string().optional(),
  bindings: z.array(bindingSchema).default([]),
  dm_policy: dmPolicySchema.default("allow_list"),
  /** Discord user IDs (snowflakes) allowed to DM the bot under "allow_list". */
  dm_allow_list: z.array(z.string()).default([]),
  approval_tags: z.array(z.string()).default(["write", "exec", "network"]),
  max_message_length: z.number().int().positive().default(1900),
  stream_edits: z.boolean().default(true),
});

export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type DiscordBinding = z.infer<typeof bindingSchema>;

export function resolveBotToken(config: DiscordConfig): string {
  const token = process.env[config.bot_token_env];
  if (!token) {
    throw new Error(`Discord bot token missing: set ${config.bot_token_env}`);
  }
  return token;
}

export function resolveGatewayToken(config: DiscordConfig): string {
  if (config.gateway_token) return config.gateway_token;
  if (config.gateway_token_env) {
    const token = process.env[config.gateway_token_env];
    if (token) return token;
  }
  throw new Error(
    `Gateway token missing: set config.gateway_token or config.gateway_token_env`,
  );
}
