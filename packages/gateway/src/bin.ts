#!/usr/bin/env node
import { boot, logger, loadConfig } from "./index.js";
import { runSupervisor } from "./restart/supervisor.js";

async function runGateway(): Promise<void> {
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

async function main(): Promise<void> {
  // Two roles, one binary:
  //   - When run by a user, this process becomes a *supervisor* that spawns a
  //     child copy of itself with `SQUAD_SUPERVISED=1`. The supervisor
  //     respawns the child on graceful restart (exit code 75) and forwards
  //     termination signals.
  //   - When the supervisor forks us, we see `SQUAD_SUPERVISED=1` and fall
  //     through to actually running the gateway.
  //   - When something *else* is responsible for respawning us — Docker
  //     `restart: unless-stopped`, systemd `Restart=always`, k8s, etc. —
  //     callers set `SQUAD_RESTART_POLICY=<anything>` and we skip the
  //     in-process supervisor and rely on that external one. The
  //     RestartManager honors the same env var, so the agent's
  //     `restart_gateway` tool only succeeds when one of these guarantees
  //     is present.
  if (process.env.SQUAD_SUPERVISED === "1") {
    return runGateway();
  }
  const policy = process.env.SQUAD_RESTART_POLICY;
  if (typeof policy === "string" && policy.trim().length > 0) {
    return runGateway();
  }

  const entry = process.argv[1];
  if (!entry) {
    // No script path (e.g. `node -e "..."`) — fall through to direct exec.
    return runGateway();
  }

  return runSupervisor({ entry });
}

main().catch((err) => {
  logger.fatal({ err }, "gateway failed to boot");
  process.exit(1);
});
