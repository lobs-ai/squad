#!/usr/bin/env node
import { boot, logger, loadConfig } from "./index.js";

async function main(): Promise<void> {
  const configPath = process.env.SQUAD_CONFIG;
  const config = loadConfig(configPath);

  // Ensure at least one auth token is configured. The fallback lets the first
  // `docker compose up` succeed in dev.
  if (config.auth.tokens.length === 0) {
    const fallbackEnv = "SQUAD_DASHBOARD_TOKEN";
    if (!process.env[fallbackEnv]) {
      logger.fatal(
        `No auth tokens configured. Set config.auth.tokens or the ${fallbackEnv} env var.`,
      );
      process.exit(1);
    }
    config.auth.tokens.push({
      label: "dashboard",
      key_env: fallbackEnv,
      scopes: ["*"],
    });
  }

  const booted = await boot({
    config,
    ...(configPath ? { configPath } : {}),
  });
  booted.handle.http.listen(config.server.port, config.server.host, () => {
    logger.info(
      { host: config.server.host, port: config.server.port },
      "squad gateway listening",
    );
    // Channel plugins (Discord, Slack, …) dial back to the gateway over WS,
    // so they must be started AFTER the listener is up. Kicked off async —
    // per-channel failures don't block the server.
    void booted.startChannels();
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await booted.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "gateway failed to boot");
  process.exit(1);
});
