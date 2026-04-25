import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import {
  CURRENT_FILE,
  squadEnvPath,
} from "./mgr/paths.js";
import { getSquad, loadRegistry, type Squad } from "./mgr/registry.js";
import { isRunning, listRunningSquads } from "./mgr/discovery.js";

export interface Env {
  url: string;
  token: string;
  /** Which squad we resolved against (if any). Useful for status banners. */
  squad?: string;
}

/**
 * Parse a KEY=VALUE .env file into a plain object. No expansion, no quoting
 * beyond stripping a single wrapping pair of single/double quotes.
 */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Walk up from `start` looking for a `docker/.env`. Used as a back-compat path
 * for users who haven't migrated to ~/.squad/squads/ yet.
 */
function findRepoEnv(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    const envPath = join(dir, "docker", ".env");
    if (existsSync(envPath)) return envPath;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the WS URL + token from a registered squad's .env. Returns null if
 * the .env doesn't exist or has no SQUAD_DASHBOARD_TOKEN / SQUAD_TOKEN.
 */
function envFromSquad(squad: Squad): Env | null {
  const envPath = squadEnvPath(squad.name);
  if (!existsSync(envPath)) return null;
  const file = parseDotenv(readFileSync(envPath, "utf8"));
  const token = file.SQUAD_TOKEN ?? file.SQUAD_DASHBOARD_TOKEN;
  if (!token) return null;
  return {
    url: `ws://localhost:${squad.port}/ws`,
    token,
    squad: squad.name,
  };
}

/**
 * Resolve the gateway URL + auth token for the CLI. Precedence:
 *   1. process.env.SQUAD_URL + SQUAD_TOKEN (explicit override)
 *   2. process.env.SQUAD_NAME → registered squad in ~/.squad/squads.json
 *   3. ~/.squad/current pointer (set by `squad mgr use <name>`)
 *   4. Single running container with lobs.squad.name label → use it
 *   5. Single registered squad in ~/.squad/squads.json → use it
 *   6. Legacy ~/.squad/config (KEY=VALUE)
 *   7. Repo-walk fallback to docker/.env
 */
export function resolveEnv(cwd: string = process.cwd()): Env {
  // 1. Explicit env vars take priority — useful for ad-hoc debugging and CI.
  if (process.env.SQUAD_URL && process.env.SQUAD_TOKEN) {
    return { url: process.env.SQUAD_URL, token: process.env.SQUAD_TOKEN };
  }

  const reg = loadRegistry();

  // 2 + 3. Named squad: --squad/SQUAD_NAME, then ~/.squad/current.
  const named =
    process.env.SQUAD_NAME ??
    (existsSync(CURRENT_FILE) ? readFileSync(CURRENT_FILE, "utf8").trim() : "");
  if (named) {
    const squad = getSquad(reg, named);
    if (!squad) {
      throw new Error(
        `squad '${named}' not found in ~/.squad/squads.json. Run 'squad mgr ls' to see registered squads.`,
      );
    }
    const env = envFromSquad(squad);
    if (env) return env;
    throw new Error(
      `no SQUAD_DASHBOARD_TOKEN in ${squadEnvPath(squad.name)}. Edit it or run 'squad mgr create ${named}' fresh.`,
    );
  }

  // 4. Auto-detect a single running squad.
  const running = listRunningSquads().filter((r) => isRunning(r.status));
  if (running.length === 1) {
    const r = running[0]!;
    const squad = getSquad(reg, r.name) ?? { name: r.name, port: r.port };
    const env = envFromSquad(squad);
    if (env) return env;
    // Container is running but no .env in ~/.squad/squads/<name>/ — fall through.
  } else if (running.length > 1) {
    const names = running.map((r) => r.name).join(", ");
    throw new Error(
      `multiple squads running (${names}). Pick one: --squad <name>, or 'squad mgr use <name>'.`,
    );
  }

  // 5. Single registered squad — even if not running, point at it.
  if (reg.squads.length === 1) {
    const env = envFromSquad(reg.squads[0]!);
    if (env) return env;
  } else if (reg.squads.length > 1) {
    const names = reg.squads.map((s) => s.name).join(", ");
    throw new Error(
      `multiple squads registered (${names}) but none selected. ` +
        `Run 'squad mgr use <name>' or pass --squad <name>.`,
    );
  }

  // 6. Legacy ~/.squad/config from the pre-mgr setup wizard.
  const globalCfg = join(homedir(), ".squad", "config");
  if (existsSync(globalCfg)) {
    const file = parseDotenv(readFileSync(globalCfg, "utf8"));
    const port = process.env.SQUAD_PORT ?? file.SQUAD_PORT ?? "8080";
    const url = file.SQUAD_URL ?? `ws://localhost:${port}/ws`;
    const token = file.SQUAD_TOKEN ?? file.SQUAD_DASHBOARD_TOKEN;
    if (token) return { url, token };
  }

  // 7. Repo-walk for very old installs that never migrated to ~/.squad.
  const repoEnv = findRepoEnv(cwd);
  if (repoEnv) {
    const file = parseDotenv(readFileSync(repoEnv, "utf8"));
    const port = process.env.SQUAD_PORT ?? file.SQUAD_PORT ?? "8080";
    const url = file.SQUAD_URL ?? `ws://localhost:${port}/ws`;
    const token = file.SQUAD_TOKEN ?? file.SQUAD_DASHBOARD_TOKEN;
    if (token) return { url, token };
  }

  throw new Error(
    "no squad configured. Try one of:\n" +
      "  • squad mgr create <name>        create a new squad\n" +
      "  • squad mgr import               import an existing ./docker/ install\n" +
      "  • set SQUAD_URL + SQUAD_TOKEN    explicit override",
  );
}

/**
 * HTTP base URL derived from the WS URL — used for /health checks.
 */
export function httpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  const scheme = u.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${u.host}`;
}
