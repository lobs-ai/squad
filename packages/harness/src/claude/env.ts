/**
 * Environment for the Claude harness subprocess.
 *
 * Mirrors the isolation the existing claude-cli provider relies on: strip every
 * Anthropic auth/config var the runtime might read from the inherited env, then
 * set exactly the credential + config dir for this squad. Nothing leaks into
 * ~/.claude — the transcript/cred store is redirected to the per-squad
 * `configDir`.
 */

import type { HarnessStartSpec } from "../types.js";

const CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

export function buildClaudeEnv(spec: HarnessStartSpec): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const v of CLEAR_ENV) delete env[v];

  if (spec.auth.mode === "subscription") {
    env.CLAUDE_CODE_OAUTH_TOKEN = spec.auth.token;
  } else {
    env.ANTHROPIC_API_KEY = spec.auth.token;
  }
  if (spec.auth.baseUrl) env.ANTHROPIC_BASE_URL = spec.auth.baseUrl;
  if (spec.auth.provider === "bedrock") env.CLAUDE_CODE_USE_BEDROCK = "1";
  if (spec.auth.provider === "vertex") env.CLAUDE_CODE_USE_VERTEX = "1";

  // Per-squad isolation: transcripts + creds live under the squad data_dir.
  env.CLAUDE_CONFIG_DIR = spec.configDir;
  // The gateway container runs as root; Claude Code refuses bypass/permission
  // shortcuts as root unless this is set. Harmless otherwise.
  env.IS_SANDBOX = "1";
  return env;
}
