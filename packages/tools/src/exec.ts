/**
 * Exec tool — run shell commands.
 *
 * Supports cmd, workdir, timeout, and env. Detects cwd changes via a
 * sentinel marker so the agent runner can update its tracked working
 * directory.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDefinition, ToolExecutorResult } from "./types.js";
import { capOutput } from "./output-cap.js";
import { BaseTool, type ToolContext } from "./base-tool.js";
import { PROMPT_SLOTS } from "./prompt-slots.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const execToolDefinition: ToolDefinition = {
  name: "exec",
  description:
    "Execute a shell command in the current working directory or an optional workdir. " +
    "Returns structured stdout, stderr, and exit status. Prefer dedicated tools like Read, Edit, Glob, and Grep when they fit the task instead of routing everything through Bash. " +
    "Prefer targeted commands over huge output. Use timeout to limit execution time.",
  input_schema: {
    type: "object",
    properties: {
      cmd: {
        type: "string",
        description: "Shell command to execute",
      },
      command: {
        type: "string",
        description: "Backward-compatible command field; cmd is preferred",
      },
      workdir: {
        type: "string",
        description: "Working directory (defaults to agent cwd)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default 30, max 300)",
      },
      env: {
        type: "object",
        description: "Additional environment variables",
        additionalProperties: { type: "string" },
      },
    },
    required: [],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE_CHARS = 1_000_000;
const MAX_OUTPUT_CHARS = 25_000;
const MAX_OUTPUT_LINES = 500;
const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 300;
const CWD_MARKER = "__AGENTIC_CWD__";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detect a bare `cd <target>` command (not compound).
 * Returns the target or null.
 */
function parseBarecd(command: string): string | null {
  const trimmed = command.trim();
  // Match: cd, cd ~, cd /path, cd ../foo, cd "some path"
  const m = trimmed.match(/^cd(?:\s+(.+))?$/);
  if (!m) return null;
  // Compound commands contain && ; | — skip those
  if (/[&;|]/.test(trimmed)) return null;
  return (m[1] ?? "~").trim().replace(/^["']|["']$/g, "");
}

function resolveCdTarget(target: string, baseCwd: string): string | null {
  let expanded = target;
  if (expanded.startsWith("~/") || expanded === "~") {
    expanded = expanded.replace(/^~/, process.env.HOME ?? "/");
  }
  const resolved = resolve(baseCwd, expanded);
  return existsSync(resolved) ? resolved : null;
}

function wrapWithCwdMarker(command: string): string {
  return `{ ${command}\n}; __ec=$?; printf '\\n${CWD_MARKER}:%s' "$(pwd)"; exit $__ec`;
}

function extractCwdMarker(stdout: string): { cleaned: string; detectedCwd: string | null } {
  const m = stdout.match(new RegExp(`\\n?${CWD_MARKER}:(.+)$`));
  if (!m) return { cleaned: stdout, detectedCwd: null };
  return { cleaned: stdout.slice(0, m.index ?? stdout.length), detectedCwd: m[1]! };
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function execTool(
  params: Record<string, unknown>,
  defaultCwd: string,
  injectedSecrets: Record<string, string> = {},
): Promise<ToolExecutorResult> {
  const command = (params.cmd as string) ?? (params.command as string);
  if (!command || typeof command !== "string") {
    throw new Error("cmd is required and must be a string");
  }

  const workdir = (params.workdir as string) || defaultCwd;
  const timeoutRaw = typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT;
  const timeout = Math.min(Math.max(timeoutRaw, 1), MAX_TIMEOUT);
  const extraEnv =
    params.env && typeof params.env === "object"
      ? (params.env as Record<string, string>)
      : {};
  // injectedSecrets < extraEnv (params.env wins — LLM can always override)
  const env = { ...process.env, ...injectedSecrets, ...extraEnv };

  // Handle bare cd as a pure cwd change (no subprocess needed)
  const cdTarget = parseBarecd(command);
  if (cdTarget !== null) {
    const resolved = resolveCdTarget(cdTarget, workdir);
    if (resolved) {
      return { result: resolved, sideEffects: { newCwd: resolved } };
    }
    return `cd: no such directory: ${cdTarget}`;
  }

  // Foreground execution with cwd detection
  const wrapped = wrapWithCwdMarker(command);

  const { output, detectedCwd } = await new Promise<{
    output: string;
    detectedCwd: string | null;
  }>((res) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn("bash", ["-c", wrapped], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeout * 1000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE_CHARS)
        stdout += d.toString().slice(0, MAX_CAPTURE_CHARS - stdout.length);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE_CHARS)
        stderr += d.toString().slice(0, MAX_CAPTURE_CHARS - stderr.length);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      res({ output: `Error: ${err.message}`, detectedCwd: null });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const { cleaned, detectedCwd: cwd } = extractCwdMarker(stdout);

      const stdoutText =
        cleaned.length > 0
          ? capOutput(
              cleaned,
              MAX_OUTPUT_CHARS,
              MAX_OUTPUT_LINES,
              "Re-run with a more targeted command (head, tail, grep, sed -n) to inspect less output.",
            )
          : "(empty)";
      const stderrText =
        stderr.length > 0
          ? capOutput(
              stderr,
              MAX_OUTPUT_CHARS,
              MAX_OUTPUT_LINES,
              "Re-run with a more targeted command to inspect less stderr output.",
            )
          : "(empty)";

      const exitStatus = killed
        ? "timeout"
        : code !== null
          ? String(code)
          : `signal ${signal}`;

      const sections = [
        `command: ${command}`,
        `cwd: ${workdir}`,
        `stdout:\n${stdoutText}`,
        `stderr:\n${stderrText}`,
        `exit_code: ${exitStatus}`,
      ];
      if (killed) sections.push(`timeout_seconds: ${timeout}`);

      res({ output: sections.join("\n\n"), detectedCwd: cwd });
    });
  });

  const newCwd =
    detectedCwd && detectedCwd !== workdir ? detectedCwd : undefined;

  if (newCwd) {
    return { result: output, sideEffects: { newCwd } };
  }
  return output;
}

// ── Class-based API ───────────────────────────────────────────────────────────

export interface ExecToolOptions {
  /**
   * Static secrets injected into every subprocess environment.
   * Resolved once at construction time from env vars or a secrets store.
   *
   * Per-call secrets in `ToolContext.secrets` are merged on top of these,
   * and `params.env` (LLM-supplied) wins over both.
   *
   * @example
   * ```ts
   * new ExecTool({ secrets: { GH_TOKEN: process.env.GH_TOKEN ?? "" } })
   * ```
   */
  secrets?: Record<string, string>;
}

export class ExecTool extends BaseTool {
  readonly name = "exec";
  readonly tags = ["exec", "shell"] as const;
  readonly description = execToolDefinition.description;
  readonly inputSchema = execToolDefinition.input_schema as import("./base-tool.js").ToolInputSchema;

  describe(
    ctx: import("./prompt-context.js").PromptContextSnapshot,
    render: import("./prompt-context.js").RenderContext,
  ): string {
    const frags = ctx.fragments
      .filter((f) => f.slot === PROMPT_SLOTS.EXEC_ENVIRONMENT_WARNINGS)
      .filter((f) => {
        if (!f.when) return true;
        try {
          return f.when(render, ctx);
        } catch {
          return false;
        }
      })
      .map((f) => f.content);
    if (frags.length === 0) return execToolDefinition.description;
    return [
      execToolDefinition.description,
      "",
      "Environment warnings (loaded plugins):",
      ...frags.map((f) => "  - " + f),
    ].join("\n");
  }

  private readonly _staticSecrets: Record<string, string>;

  constructor({ secrets = {} }: ExecToolOptions = {}) {
    super();
    this._staticSecrets = secrets;
  }

  run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutorResult> {
    // static constructor secrets < per-call ctx.secrets (caller wins over defaults)
    const injected = { ...this._staticSecrets, ...ctx.secrets };
    return execTool(params, ctx.cwd, injected);
  }
}
