import { z } from "zod";

export const bindingSchema = z.union([
  z.object({ guild_id: z.string(), channel_id: z.string() }),
  z.object({ dm: z.literal(true) }),
]);

export const discordConfigSchema = z.object({
  bot_token_env: z.string().default("DISCORD_BOT_TOKEN"),
  gateway_url: z.string().default("ws://127.0.0.1:8080/ws"),
  gateway_token_env: z.string().optional(),
  gateway_token: z.string().optional(),
  bindings: z.array(bindingSchema).default([]),
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
