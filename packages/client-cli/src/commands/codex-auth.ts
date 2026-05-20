/**
 * `squad codex-auth login` — run the OAuth PKCE flow for the ChatGPT
 * (Codex subscription) provider on the host machine.
 *
 * The flow opens a browser, captures the authorization code on a
 * localhost callback server (port 1455), exchanges it for tokens, and
 * writes a credentials JSON to `docker/data/codex-creds.json` (or to a
 * caller-supplied path). The refresh token is what the gateway needs at
 * runtime — squad never reads `~/.codex/auth.json`, so a clean separation
 * between "this host's logged-in user" and "what squad uses" is
 * preserved.
 *
 * Typical workflow:
 *   $ squad codex-auth login
 *   <browser opens, complete login>
 *   ✓ saved to /…/squad/docker/data/codex-creds.json
 *
 *     OPENAI_CODEX_REFRESH_TOKEN=<value>
 *
 *   <paste into .env or docker-compose, restart squad>
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { platform } from "node:os";
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
  type CodexCredentials,
} from "@squad/llm";

/** Walk up from cwd looking for the squad workspace root. */
function findRepoRoot(): string {
  let dir = resolve(process.env.SQUAD_REPO ?? process.cwd());
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "can't locate the squad repo. Set SQUAD_REPO=/path/to/squad or run from inside it.",
  );
}

const DEFAULT_REL_PATH = "docker/data/codex-creds.json";

interface LoginOpts {
  /** Output path. Relative paths are resolved against the squad repo root. */
  output?: string;
  /** Skip the automatic browser open. The URL is printed regardless. */
  noBrowser?: boolean;
}

export async function runCodexAuthLogin(opts: LoginOpts = {}): Promise<void> {
  const outPath = resolveOutputPath(opts.output);
  console.log("→ starting OpenAI Codex (ChatGPT subscription) OAuth flow");
  console.log(`  credentials will be written to ${outPath}`);
  console.log("");

  const creds = await loginOpenAICodex({
    onAuthUrl: (url) => {
      console.log("→ open this URL to authorize squad (browser may open automatically):");
      console.log(`  ${url}`);
      if (!opts.noBrowser) tryOpenBrowser(url);
    },
    originator: "squad",
  });

  writeCredsFile(outPath, creds);

  console.log("");
  console.log(`✓ saved credentials to ${outPath}`);
  console.log("");
  console.log("Next: set this env var (in .env, docker-compose, or your shell)");
  console.log("");
  console.log(`  OPENAI_CODEX_REFRESH_TOKEN=${creds.refresh}`);
  console.log("");
  console.log("Then add openai-codex to your config.json:");
  console.log("");
  console.log("  \"providers\": {");
  console.log("    \"openai-codex\": { \"refresh_token_env\": \"OPENAI_CODEX_REFRESH_TOKEN\" }");
  console.log("  }");
}

/** Show what refresh token / cache file is in place, and refresh on demand. */
export async function runCodexAuthStatus(opts: { output?: string } = {}): Promise<void> {
  const credsPath = resolveOutputPath(opts.output);
  if (!existsSync(credsPath)) {
    console.log(`no credentials file at ${credsPath}`);
    console.log("run `squad codex-auth login` to create one.");
    return;
  }
  const { readFileSync } = await import("node:fs");
  try {
    const parsed = JSON.parse(readFileSync(credsPath, "utf-8")) as Partial<CodexCredentials>;
    if (!parsed.access || !parsed.refresh || !parsed.expires) {
      console.log(`✗ ${credsPath} is missing required fields`);
      return;
    }
    const remaining = Math.max(0, parsed.expires - Date.now());
    const minutes = Math.floor(remaining / 60_000);
    console.log(`path:        ${credsPath}`);
    console.log(`accountId:   ${parsed.accountId ?? "(unknown — derive from JWT)"}`);
    console.log(`expires:     ${new Date(parsed.expires).toISOString()} (${minutes}m from now)`);
    console.log(`access:      ${parsed.access.slice(0, 24)}…`);
    console.log(`refresh:     ${parsed.refresh.slice(0, 12)}…`);
  } catch (err) {
    console.log(`✗ failed to read ${credsPath}: ${(err as Error).message}`);
  }
}

export async function runCodexAuthRefresh(opts: { output?: string } = {}): Promise<void> {
  const credsPath = resolveOutputPath(opts.output);
  if (!existsSync(credsPath)) {
    throw new Error(`no credentials file at ${credsPath}. Run \`squad codex-auth login\` first.`);
  }
  const { readFileSync } = await import("node:fs");
  const parsed = JSON.parse(readFileSync(credsPath, "utf-8")) as Partial<CodexCredentials>;
  if (!parsed.refresh) throw new Error(`${credsPath} has no refresh token`);
  const refreshed = await refreshOpenAICodexToken(parsed.refresh);
  writeCredsFile(credsPath, refreshed);
  console.log(`✓ refreshed; new expiry ${new Date(refreshed.expires).toISOString()}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveOutputPath(provided: string | undefined): string {
  if (provided) {
    return isAbsolute(provided) ? provided : resolve(process.cwd(), provided);
  }
  // Default: <repo>/docker/data/codex-creds.json so docker-compose's
  // bind mount picks it up automatically.
  return join(findRepoRoot(), DEFAULT_REL_PATH);
}

function writeCredsFile(path: string, creds: CodexCredentials): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(creds, null, 2), "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

function tryOpenBrowser(url: string): void {
  const opener =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* silently fall through — the URL is already printed */
  }
}
