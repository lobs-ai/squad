/**
 * Claude Code CLI Provider
 *
 * Talks to Anthropic models by spawning the `claude` binary (the Claude Code
 * CLI) and parsing its `--output-format stream-json` output. This is the
 * supported way to authenticate via Claude.ai OAuth instead of an API key —
 * the user runs `claude setup-token` on a machine with browser access, hands
 * the resulting long-lived OAuth token to squad, and squad pipes it through
 * to the subprocess as `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * Limitations vs the native Anthropic SDK:
 *  - Squad's `messages` history is replayed as a `Human:` / `Assistant:`
 *    transcript on every call. No `--resume` continuity, so prompt caching
 *    only kicks in for whatever Claude Code's own prefix-cache covers.
 *  - The system prompt is appended to Claude Code's own (large) coding-
 *    assistant system prompt — there is no flag to replace it. Use this
 *    provider for "give me an Anthropic model via OAuth" workflows, not for
 *    fine-grained agent prompting.
 *  - Built-in CLI tools (Read, Bash, etc.) are locked off by default via
 *    `--allowedTools <impossible-pattern>` so the subprocess can't touch
 *    the squad container's filesystem unsolicited. Override with the
 *    `allowedTools` option if you actually want them.
 *  - `tools` passed to `createMessage` are ignored — the CLI runs its own
 *    tool loop internally and squad's runner won't see `tool_use` blocks.
 *    Use this for text-in / text-out calls (chat, summarization).
 */

import { spawn } from "node:child_process";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  CreateMessageParams,
  ContentBlock,
  TokenUsage,
} from "../types.js";

// Env vars the CLI reads to override auth / endpoint. We strip every one of
// these from the inherited environment so the only credential the subprocess
// can see is the OAuth token we explicitly set.
const CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

const DEFAULT_BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--setting-sources",
  "user",
] as const;

const NO_TOOLS_PATTERN = "__squad_no_tools__";

export interface ClaudeCliClientOptions {
  /**
   * Long-lived OAuth token produced by `claude setup-token`. Required.
   * If absent, calls will fail before the subprocess is spawned.
   */
  oauthToken?: string;
  /** Path or name of the `claude` binary. Defaults to "claude" (on $PATH). */
  binary?: string;
  /** Working directory for the subprocess. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Pattern passed to `--allowedTools`. Defaults to an impossible pattern
   * that blocks every built-in tool. Set to e.g. `"*"` to allow all.
   */
  allowedTools?: string;
  /** Hard timeout (ms) for a single call. Defaults to 10 minutes. */
  timeoutMs?: number;
}

/**
 * Spawn-injection point — exposed for tests. Production code uses node's
 * `spawn` directly; tests can swap in a fake that emits scripted stdout.
 */
export type SpawnFn = typeof spawn;

interface CliEvent {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: unknown;
  usage?: Record<string, unknown>;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  subtype?: string;
}

function parseEvent(line: string): CliEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as CliEvent;
  } catch {
    return null;
  }
}

function readNumber(o: Record<string, unknown> | undefined, key: string): number {
  if (!o) return 0;
  const v = o[key];
  return typeof v === "number" ? v : 0;
}

function buildTranscript(messages: LLMMessage[]): string {
  // Squad treats every call as stateless: replay the conversation as a
  // human-readable transcript ending with the latest user turn. The CLI
  // wraps this in its own user turn — Claude reads the transcript and
  // continues as the assistant.
  if (messages.length === 0) return "";
  if (messages.length === 1) {
    const only = messages[0]!;
    if (only.role === "user" && typeof only.content === "string") {
      return only.content;
    }
  }
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "user" ? "Human" : "Assistant";
    const body =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    lines.push(`${role}: ${body}`);
  }
  return lines.join("\n\n");
}

function buildEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of CLEAR_ENV) delete env[v];
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

function detectAuthError(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("401") ||
    s.includes("403") ||
    s.includes("unauthorized") ||
    s.includes("invalid api key") ||
    s.includes("oauth") ||
    s.includes("authentication") ||
    s.includes("token expired") ||
    s.includes("setup-token")
  );
}

class ClaudeCliError extends Error {
  /** HTTP-style status so `classifyError` routes auth failures to "auth_error". */
  status?: number;
  /** stderr captured from the subprocess, for diagnostics. */
  stderr?: string;

  constructor(message: string, opts?: { status?: number; stderr?: string }) {
    super(message);
    this.name = "ClaudeCliError";
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.stderr !== undefined) this.stderr = opts.stderr;
  }
}

interface RunResult {
  text: string;
  usage: TokenUsage;
  thinkingContent?: string;
}

/**
 * Drive a single `claude -p ...` invocation to completion, streaming text
 * deltas to `onChunk`. Returns the final assembled text + usage.
 */
function runCli(
  binary: string,
  args: string[],
  stdinPayload: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  spawnFn: SpawnFn,
  onChunk: (text: string) => void,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawnFn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
    });

    let stderr = "";
    let stdoutBuf = "";
    let resultText = "";
    let deltaText = "";
    let thinkingContent: string | undefined;
    let usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let firstError: { message: string; isAuth: boolean } | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore — process may already be gone */
      }
      reject(
        new ClaudeCliError(`claude CLI timed out after ${timeoutMs}ms`, {
          status: 408,
          stderr,
        }),
      );
    }, timeoutMs);

    const handleEvent = (ev: CliEvent) => {
      const t = ev.type;
      if (t === "stream_event" && ev.event) {
        const inner = ev.event;
        if (
          inner.type === "content_block_delta" &&
          inner.delta?.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          deltaText += inner.delta.text;
          onChunk(inner.delta.text);
        }
        return;
      }
      if (t === "result") {
        if (typeof ev.result === "string") resultText = ev.result;
        if (ev.usage) {
          usage = {
            inputTokens: readNumber(ev.usage, "input_tokens"),
            outputTokens: readNumber(ev.usage, "output_tokens"),
            cacheReadTokens: readNumber(ev.usage, "cache_read_input_tokens"),
            cacheWriteTokens: readNumber(ev.usage, "cache_creation_input_tokens"),
          };
        }
        if (ev.is_error === true && !firstError) {
          const msg =
            typeof ev.result === "string" && ev.result.length > 0
              ? ev.result
              : "claude CLI reported an error";
          firstError = { message: msg, isAuth: detectAuthError(msg) };
        }
        return;
      }
      if (t === "error" || ev.is_error === true) {
        const raw = ev.message ?? ev.result;
        const msg =
          typeof raw === "string"
            ? raw
            : raw
              ? JSON.stringify(raw)
              : "claude CLI reported an error";
        if (!firstError) firstError = { message: msg, isAuth: detectAuthError(msg) };
        return;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const ev = parseEvent(line);
        if (ev) handleEvent(ev);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT means the binary is missing — surface a clean message so the
      // user knows to install @anthropic-ai/claude-code.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new ClaudeCliError(
            `claude CLI not found (tried "${binary}"). ` +
              `Install with: npm install -g @anthropic-ai/claude-code`,
            { status: 500, stderr },
          ),
        );
        return;
      }
      reject(
        new ClaudeCliError(`failed to spawn claude CLI: ${err.message}`, {
          stderr,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Drain any trailing partial line.
      if (stdoutBuf.trim().length > 0) {
        const ev = parseEvent(stdoutBuf);
        if (ev) handleEvent(ev);
      }

      if (firstError) {
        reject(
          new ClaudeCliError(`claude CLI: ${firstError.message}`, {
            status: firstError.isAuth ? 401 : undefined,
            stderr,
          }),
        );
        return;
      }
      if (code !== 0) {
        const isAuth = detectAuthError(stderr);
        reject(
          new ClaudeCliError(
            `claude CLI exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
            { status: isAuth ? 401 : undefined, stderr },
          ),
        );
        return;
      }

      // Prefer the final `result` payload if the CLI emitted one — it carries
      // the canonical assistant text. Fall back to the streamed deltas for
      // older CLI versions that don't emit a result block.
      const text = resultText.length > 0 ? resultText : deltaText;
      resolve({
        text,
        usage,
        ...(thinkingContent !== undefined ? { thinkingContent } : {}),
      });
    });

    // Send the rendered transcript and close stdin so the CLI knows the
    // prompt is complete.
    child.stdin.on("error", () => {
      /* ignore — closed pipe surfaces via "close" with non-zero exit */
    });
    child.stdin.end(stdinPayload, "utf8");
  });
}

/**
 * LLMClient backed by the Claude Code CLI.
 *
 * @example
 * ```ts
 * const client = new ClaudeCliClient({
 *   oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
 * });
 * const response = await client.createMessage({
 *   model: "claude-sonnet-4-5",
 *   system: "You are a helpful assistant.",
 *   messages: [{ role: "user", content: "Hello!" }],
 *   tools: [],
 *   maxTokens: 1024,
 * });
 * ```
 */
export class ClaudeCliClient implements LLMClient {
  private readonly oauthToken: string | undefined;
  private readonly binary: string;
  private readonly cwd: string;
  private readonly allowedTools: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;

  constructor(options: ClaudeCliClientOptions = {}, spawnFn: SpawnFn = spawn) {
    this.oauthToken = options.oauthToken;
    this.binary = options.binary ?? "claude";
    this.cwd = options.cwd ?? process.cwd();
    this.allowedTools = options.allowedTools ?? NO_TOOLS_PATTERN;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.spawnFn = spawnFn;
  }

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    return this.run(params, () => {});
  }

  async streamMessage(
    params: CreateMessageParams,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    return this.run(params, onChunk);
  }

  private async run(
    params: CreateMessageParams,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    if (!this.oauthToken || this.oauthToken.trim().length === 0) {
      // 401 so the model chain classifies this as an auth error and either
      // surfaces it cleanly or falls through to a non-CLI fallback.
      throw new ClaudeCliError(
        "claude-cli requires an OAuth token. Run `claude setup-token` on a " +
          "machine with browser access and set CLAUDE_CODE_OAUTH_TOKEN.",
        { status: 401 },
      );
    }

    const args: string[] = [
      ...DEFAULT_BASE_ARGS,
      "--model",
      params.model,
      "--allowedTools",
      this.allowedTools,
    ];
    if (params.system && params.system.length > 0) {
      args.push("--append-system-prompt", params.system);
    }

    const stdinPayload = buildTranscript(params.messages);
    const env = buildEnv(this.oauthToken);

    const result = await runCli(
      this.binary,
      args,
      stdinPayload,
      env,
      this.cwd,
      this.timeoutMs,
      this.spawnFn,
      onChunk,
    );

    const content: ContentBlock[] = [];
    if (result.text.length > 0) {
      content.push({ type: "text", text: result.text });
    }

    return {
      content,
      stopReason: "end_turn",
      usage: result.usage,
      ...(result.thinkingContent !== undefined
        ? { thinkingContent: result.thinkingContent }
        : {}),
    };
  }
}

// Exposed for unit tests that want to assert on the no-tools sentinel without
// importing the file twice.
export const __INTERNAL = {
  NO_TOOLS_PATTERN,
  CLEAR_ENV,
  DEFAULT_BASE_ARGS,
  buildTranscript,
  buildEnv,
  detectAuthError,
};
