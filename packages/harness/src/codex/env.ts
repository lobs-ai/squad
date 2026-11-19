/**
 * Environment for the Codex harness subprocess. Isolates Codex's session +
 * credential store per squad via CODEX_HOME (Codex's analogue of ~/.codex), so
 * nothing leaks into the operator's own ~/.codex. Auth flows through
 * `CodexOptions.apiKey`, so an inherited OPENAI_API_KEY is stripped to avoid
 * shadowing the configured credential.
 */

import type { HarnessStartSpec } from "../types.js";

export function buildCodexEnv(spec: HarnessStartSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.CODEX_HOME = spec.configDir;
  delete env.OPENAI_API_KEY;
  return env;
}
