import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface Env {
  url: string;
  token: string;
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
 * Walk up from `start` looking for a `docker/.env` next to a `docker-compose.yml`
 * or `package.json` (treat that as a repo root). Returns null if none found.
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
 * Resolve the gateway URL + auth token for the CLI. Precedence:
 *   1. explicit process.env.SQUAD_URL / SQUAD_TOKEN
 *   2. ~/.squad/config (KEY=VALUE)
 *   3. <repo>/docker/.env walking up from cwd
 */
export function resolveEnv(cwd: string = process.cwd()): Env {
  const fromProcess = {
    url: process.env.SQUAD_URL,
    token: process.env.SQUAD_TOKEN ?? process.env.SQUAD_DASHBOARD_TOKEN,
  };

  let fromFile: Record<string, string> = {};
  const globalCfg = join(homedir(), ".squad", "config");
  if (existsSync(globalCfg)) {
    fromFile = { ...fromFile, ...parseDotenv(readFileSync(globalCfg, "utf8")) };
  }
  const repoEnv = findRepoEnv(cwd);
  if (repoEnv) {
    fromFile = { ...fromFile, ...parseDotenv(readFileSync(repoEnv, "utf8")) };
  }

  const port = process.env.SQUAD_PORT ?? fromFile.SQUAD_PORT ?? "8080";
  const url =
    fromProcess.url ??
    fromFile.SQUAD_URL ??
    `ws://localhost:${port}/ws`;
  const token =
    fromProcess.token ??
    fromFile.SQUAD_TOKEN ??
    fromFile.SQUAD_DASHBOARD_TOKEN ??
    "";

  if (!token) {
    throw new Error(
      "no SQUAD_TOKEN found. Set SQUAD_TOKEN, or run `scripts/start.sh` so docker/.env is generated.",
    );
  }
  return { url, token };
}

/**
 * HTTP base URL derived from the WS URL — used for /health checks.
 */
export function httpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  const scheme = u.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${u.host}`;
}
