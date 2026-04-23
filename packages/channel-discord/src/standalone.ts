#!/usr/bin/env node
import { discordConfigSchema } from "./config.js";
import { DiscordChannel } from "./channel.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

async function main(): Promise<void> {
  const configPath = process.env.SQUAD_DISCORD_CONFIG;
  if (!configPath) {
    console.error("SQUAD_DISCORD_CONFIG is required (path to a yaml file)");
    process.exit(1);
  }
  const raw = readFileSync(configPath, "utf8");
  const parsed = parseYaml(raw) as unknown;
  const config = discordConfigSchema.parse(parsed);

  const channel = new DiscordChannel({ config });
  await channel.connect();
  console.error("discord channel connected");

  const shutdown = async (signal: string): Promise<void> => {
    console.error("shutting down", signal);
    await channel.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
