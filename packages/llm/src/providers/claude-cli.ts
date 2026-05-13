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

import { AsyncResource } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  CreateMessageParams,
  ContentBlock,
  TokenUsage,
  ToolDefinition,
  ToolEvent,
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

/**
 * Sentinel for the explicit override that means "let the CLI use its full
 * built-in toolbox". Translates to `--tools default` (Claude Code's own
 * convention for "every built-in is available"). Anything else passed via
 * `allowedTools` is sent through verbatim as the `--tools` value.
 */
const OVERRIDE_ALL = "*";

/**
 * Map squad's tool names to Claude Code's built-in tool names. Used by
 * `classifyTools` to decide, for each tool the runner authorized this turn,
 * whether the CLI can satisfy it with a native built-in or whether the call
 * must round-trip through the MCP bridge to squad's executor.
 *
 * Inclusion rule: a tool belongs here only when it's a direct 1:1 with a
 * Claude Code built-in. The implementations differ (Claude Code's `Read`
 * is not squad's `read`), so calls via this path bypass squad's approval/
 * tag-policy machinery — that's the accepted trade-off when using
 * claude-cli as a provider.
 *
 * Exclusion rule: tools that look adjacent but aren't 1:1 stay out. For
 * example `ls` is left out so that "I'm allowed to list a directory" can't
 * implicitly hand the agent full Bash — if the runner wants ls without
 * exec, the call goes through MCP and runs squad's own implementation.
 * Likewise `code_search`: the model can compose Grep/Glob if those are
 * authorized, and falls back to squad's executor via MCP otherwise.
 *
 * Tools not in this table route through the per-call MCP bridge when an
 * executor is configured, or are dropped silently when it isn't.
 */
export const SQUAD_TO_CC_TOOL_MAP: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  exec: "Bash",
  grep: "Grep",
  glob: "Glob",
  find_files: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

/**
 * Reverse of SQUAD_TO_CC_TOOL_MAP for display. When the CLI reports tool
 * activity in its JSON stream, the names are CC built-ins (`Read`, `Bash`)
 * — we translate them back to squad's namespace (`read`, `exec`) so the
 * dashboard / CLI client render them identically to native tool calls.
 *
 * Where two squad tools mapped to the same CC tool (e.g. `glob` and
 * `find_files` → `Glob`), we pick the canonical squad name. Display only;
 * no execution depends on the choice.
 */
const CC_TO_SQUAD_TOOL_MAP: Readonly<Record<string, string>> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "exec",
  Grep: "grep",
  Glob: "glob",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
};

/** Prefix Claude Code uses to namespace MCP-bridged tools. */
const MCP_TOOL_PREFIX = "mcp__squad__";

/**
 * Normalize a CC-side tool name to squad's namespace so progress events
 * the runner broadcasts match what a native model's `tool_use` blocks
 * would produce. Mapped CC built-ins → their squad alias; `mcp__squad__X`
 * → `X`; anything else passes through unchanged.
 */
function normalizeToolName(ccName: string): string {
  if (ccName.startsWith(MCP_TOOL_PREFIX)) {
    return ccName.slice(MCP_TOOL_PREFIX.length);
  }
  return CC_TO_SQUAD_TOOL_MAP[ccName] ?? ccName;
}

/**
 * Callback the gateway supplies so the in-process MCP bridge can run squad
 * tools that don't map to a Claude Code built-in. Given a squad tool name
 * and its JSON-shaped input, returns the textual result the bridge forwards
 * back to the CLI as a `tools/call` response.
 */
export type SquadToolExecutor = (
  name: string,
  params: Record<string, unknown>,
) => Promise<string>;

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
   * Override for the CLI's `--tools` flag (built-in availability, not the
   * permission whitelist). When set, takes precedence over the per-call
   * `params.tools` mapping. `"*"` is rewritten to `"default"` (CC's name
   * for "all built-ins"). Defaults to undefined — the client derives the
   * built-in list from `params.tools` and SQUAD_TO_CC_TOOL_MAP, and any
   * built-in not in that list is invisible to the model.
   */
  allowedTools?: string;
  /** Hard timeout (ms) for a single call. Defaults to 10 minutes. */
  timeoutMs?: number;
  /**
   * Executor for squad tools that don't map to a Claude Code built-in.
   * When provided, the client spawns a per-call Unix-socket MCP bridge so
   * the CLI's agent loop can call those tools via `mcp__squad__<name>`.
   * Typically wired to `toolRegistry.execute` by the gateway.
   */
  executeTool?: SquadToolExecutor;
  /**
   * Returns the squad tools currently in scope for the active session.
   * Called after every MCP `tools/call` so the bridge can detect dynamic
   * catalog changes (e.g. describe_tool_group unlocking a lazy group):
   * when the result differs from what the bridge currently advertises,
   * the bridge sends `notifications/tools/list_changed` and the CLI
   * re-queries `tools/list` mid-run. Without this, the unlocked tools
   * stay invisible to the CLI until the next gateway turn.
   */
  getActiveTools?: () => ToolDefinition[] | undefined;
}

/**
 * Spawn-injection point — exposed for tests. Production code uses node's
 * `spawn` directly; tests can swap in a fake that emits scripted stdout.
 */
export type SpawnFn = typeof spawn;

interface CliContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

interface CliStreamInner {
  type?: string;
  index?: number;
  content_block?: CliContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

interface CliAssistantMessage {
  content?: CliContentBlock[];
}

interface CliEvent {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: CliAssistantMessage | unknown;
  usage?: Record<string, unknown>;
  event?: CliStreamInner;
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

/** MCP server id used in the generated mcp.json. Tool names appear in
 * Claude Code as `mcp__squad__<toolname>`. */
const MCP_SERVER_ID = "squad";

/**
 * Stdio↔Unix-socket bridge. Claude Code spawns this as the MCP server
 * subprocess; it just connects to the per-call socket we opened in-process
 * and pipes the JSON-RPC frames back and forth.
 *
 * Embedded as a string so the package doesn't have to ship a separate
 * artifact in dist/ — we write it to a temp file per call and exec node
 * with it.
 */
const MCP_BRIDGE_SCRIPT = `import net from "node:net";
const path = process.argv[2];
if (!path) { process.stderr.write("squad-mcp-bridge: missing socket path\\n"); process.exit(2); }
const sock = net.connect(path);
sock.on("error", (e) => { process.stderr.write("squad-mcp-bridge: socket error: " + e.message + "\\n"); process.exit(1); });
sock.on("close", () => process.exit(0));
process.stdin.pipe(sock);
sock.pipe(process.stdout);
`;

/**
 * Run the MCP JSON-RPC protocol on a stream pair, exposing the tools
 * returned by `getTools` (called fresh on every `tools/list`) and routing
 * `tools/call` requests through `executor`. Designed to be invoked on
 * each accepted connection of a per-call Unix socket — short lifetime,
 * no shared state.
 *
 * The connection advertises `tools.listChanged: true`, so the bridge can
 * send `notifications/tools/list_changed` later when the underlying tool
 * set grows (e.g. an unlocked tool group) and the CLI will re-fetch.
 */
function runMcpServerOnConnection(
  socket: Socket,
  getTools: () => ToolDefinition[],
  executor: SquadToolExecutor,
  onToolsListServed?: () => void,
): void {
  let buffer = "";
  const write = (msg: Record<string, unknown>): void => {
    socket.write(JSON.stringify(msg) + "\n");
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      void handleFrame(msg);
    }
  });

  const handleFrame = async (msg: Record<string, unknown>): Promise<void> => {
    const id = msg.id;
    const method = msg.method;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "initialize") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "squad-mcp-bridge", version: "0.0.0" },
        },
      });
      return;
    }
    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          tools: getTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
          })),
        },
      });
      // Signal that the CLI has just re-pulled the catalog. The bridge
      // uses this to gate `tools/call` responses that triggered a
      // `list_changed` — see setupMcpBridge — so the model's next
      // assistant turn is built against the refreshed tool set instead
      // of racing the notification.
      onToolsListServed?.();
      return;
    }

    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await executor(name, args);
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result }],
          },
        });
      } catch (err) {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              { type: "text", text: err instanceof Error ? err.message : String(err) },
            ],
          },
        });
      }
      return;
    }

    if (typeof id !== "undefined") {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      });
    }
  };
}

interface BridgeResources {
  tempDir: string;
  socketServer: Server;
  mcpConfigPath: string;
  cleanup: () => void;
}

/**
 * Spin up the per-call MCP bridge: temp dir, unix socket server, bridge
 * script file, and an mcp.json pointing the CLI at the bridge. Returns
 * the path of the mcp config and a cleanup hook that tears it all down.
 *
 * On every accepted socket connection we run the MCP protocol with the
 * provided tool set + executor. The agent loop is one-shot so we expect
 * at most one connection per call, but the server happily handles more.
 */
/**
 * `refreshTools`, when supplied, runs after every successful
 * `tools/call`. It is expected to:
 *  1. recompute the current tool set,
 *  2. update whatever closure `getTools` reads,
 *  3. return `true` iff the set just changed.
 *
 * On `true` the bridge fans `notifications/tools/list_changed` out to
 * every connected client so the CLI re-queries `tools/list`. This is how
 * `describe_tool_group` makes its unlocked tools callable within the
 * same CLI run instead of after the next gateway turn.
 */
function setupMcpBridge(
  getTools: () => ToolDefinition[],
  executor: SquadToolExecutor,
  refreshTools: (() => boolean) | undefined,
  onError: (err: Error) => void,
): BridgeResources {
  const tempDir = mkdtempSync(join(tmpdir(), "squad-mcp-"));
  const socketPath = join(tempDir, "bridge.sock");
  const bridgePath = join(tempDir, "bridge.mjs");
  const mcpConfigPath = join(tempDir, "mcp.json");

  writeFileSync(bridgePath, MCP_BRIDGE_SCRIPT, "utf8");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_ID]: {
          command: "node",
          args: [bridgePath, socketPath],
        },
      },
    }),
    "utf8",
  );

  const connections = new Set<Socket>();
  const broadcastListChanged = (): void => {
    const frame =
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n";
    for (const conn of connections) {
      try {
        conn.write(frame);
      } catch {
        /* best-effort — client may have dropped */
      }
    }
  };

  // Resolvers waiting for the CLI's next `tools/list`. The CLI processes
  // `notifications/tools/list_changed` asynchronously, so without gating
  // here the bridge's `tools/call` response races the refresh: the model
  // sees the tool_result first, builds its next API call against the
  // *stale* catalog, and Claude Code rejects the unlocked tool with
  // "No such tool available". Holding the response until tools/list
  // arrives (capped by a short timeout) makes the catalog refresh
  // happen-before the next assistant turn.
  let toolsListWaiters: Array<() => void> = [];
  const onToolsListServed = (): void => {
    const waiters = toolsListWaiters;
    toolsListWaiters = [];
    for (const w of waiters) w();
  };
  const TOOLS_LIST_WAIT_MS = 1500;
  const waitForToolsListRefresh = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, TOOLS_LIST_WAIT_MS);
      toolsListWaiters.push(finish);
    });

  const executorWithListRefresh: SquadToolExecutor = refreshTools
    ? async (name, params) => {
        const result = await executor(name, params);
        let triggered = false;
        try {
          triggered = refreshTools();
          if (triggered) broadcastListChanged();
        } catch {
          /* a bad refresh callback must not break the tool result */
        }
        if (triggered) {
          // Wait for the CLI to actually re-pull tools/list (or time out)
          // before letting the tool result reach the model.
          await waitForToolsListRefresh();
        }
        return result;
      }
    : executor;

  // The bridge's client is the spawned `claude` subprocess, so its socket
  // connections come from outside this process's async context and Node
  // does not propagate AsyncLocalStorage across that boundary. The gateway
  // reads `currentAgentContext()` inside the executor to attach the live
  // `sessionId` to tool meta — without binding, that read returns
  // `undefined` and any tool that gates on sessionId (notably
  // describe_tool_group → sessions.unlockGroup) silently no-ops.
  const boundExecutor = AsyncResource.bind(executorWithListRefresh);
  const socketServer = createServer((conn) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    runMcpServerOnConnection(conn, getTools, boundExecutor, onToolsListServed);
  });
  socketServer.on("error", (err) => onError(err));
  socketServer.listen(socketPath);

  const cleanup = (): void => {
    try {
      socketServer.close();
    } catch {
      /* ignore */
    }
    for (const conn of connections) {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    }
    connections.clear();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore — cleanup is best-effort */
    }
  };

  return { tempDir, socketServer, mcpConfigPath, cleanup };
}

function buildEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of CLEAR_ENV) delete env[v];
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Claude Code refuses `--permission-mode bypassPermissions` when it
  // detects it's running as root unless this is set — its documented
  // sandbox escape hatch. Squad's docker image runs the gateway as root,
  // so without this the chat subprocess exits immediately with
  // "--dangerously-skip-permissions cannot be used with root/sudo
  // privileges" on stderr and an empty stdout, and the user sees a
  // blank assistant reply.
  env.IS_SANDBOX = "1";
  return env;
}

function summarizeToolInput(rawJson: string, maxLen = 120): string {
  const trimmed = rawJson.trim();
  if (!trimmed) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Streaming may emit a partial JSON if the tool block ended mid-stream;
    // surface what we have so the user can at least see the intent.
    const clipped = trimmed.replace(/\s+/g, " ");
    return clipped.length > maxLen ? clipped.slice(0, maxLen - 1) + "…" : clipped;
  }
  if (parsed && typeof parsed === "object") {
    // For single-key inputs (the common case — Read{path}, Bash{command}),
    // show just the value so the marker stays readable.
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 1) {
      const [, v] = entries[0]!;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
    }
    const s = JSON.stringify(parsed);
    return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
  }
  return String(parsed);
}

function summarizeToolResult(block: CliContentBlock, maxLen = 120): string {
  const raw = block.content;
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((b: unknown): b is { type: string; text?: string } =>
        typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
      )
      .map((b) => b.text ?? "")
      .join(" ");
  } else {
    text = "";
  }
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return block.is_error ? "(error)" : "(no output)";
  return flattened.length > maxLen ? flattened.slice(0, maxLen - 1) + "…" : flattened;
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
 *
 * When `onToolEvent` is provided, tool activity parsed from the CLI's
 * stream is forwarded structurally — caller can wire it to the same
 * progress/broadcast layer a native model's tool_use blocks feed. When
 * absent, the older inline `[→ Read: foo]` markers are written to
 * `onChunk` as a fallback so plain text consumers still see tool calls.
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
  onToolEvent: ((event: ToolEvent) => void) | undefined,
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

    // In-flight tool_use blocks indexed by their stream position. Claude
    // Code's JSONL stream emits content_block_start → input_json_delta* →
    // content_block_stop; we batch the JSON deltas and emit a single
    // human-readable marker when the block closes.
    const pendingTools = new Map<number, { name: string; input: string }>();
    // Track tool_use ids announced this turn so we can label tool_result
    // markers that arrive later.
    const toolNamesById = new Map<string, string>();
    // Block indices we've already emitted an opening marker for, to suppress
    // duplicates from both stream_event and assistant message events.
    const announcedBlocks = new Set<string>();

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

    const emitToolStart = (name: string, input: string, id?: string): void => {
      const key = id ?? `__${name}__${announcedBlocks.size}`;
      if (announcedBlocks.has(key)) return;
      announcedBlocks.add(key);
      const squadName = normalizeToolName(name);
      if (onToolEvent) {
        let parsed: Record<string, unknown> | undefined;
        if (input.trim().length > 0) {
          try {
            const v = JSON.parse(input) as unknown;
            if (v && typeof v === "object") parsed = v as Record<string, unknown>;
          } catch {
            /* mid-stream truncation — leave toolInput undefined */
          }
        }
        onToolEvent({
          type: "tool_start",
          toolName: squadName,
          ...(parsed !== undefined ? { toolInput: parsed } : {}),
          ...(id !== undefined ? { toolUseId: id } : {}),
        });
        return;
      }
      const summary = summarizeToolInput(input);
      onChunk(summary.length > 0 ? `\n[→ ${squadName}: ${summary}]\n` : `\n[→ ${squadName}]\n`);
    };
    const emitToolResult = (block: CliContentBlock): void => {
      const ccName = block.tool_use_id ? toolNamesById.get(block.tool_use_id) : undefined;
      const squadName = ccName ? normalizeToolName(ccName) : undefined;
      if (onToolEvent) {
        const raw = block.content;
        let resultText: string;
        if (typeof raw === "string") {
          resultText = raw;
        } else if (Array.isArray(raw)) {
          resultText = raw
            .filter((b: unknown): b is { type: string; text?: string } =>
              typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
            )
            .map((b) => b.text ?? "")
            .join("");
        } else {
          resultText = "";
        }
        onToolEvent({
          type: "tool_result",
          toolName: squadName ?? "tool",
          ...(block.tool_use_id ? { toolUseId: block.tool_use_id } : {}),
          result: resultText,
          ...(block.is_error ? { isError: true } : {}),
        });
        return;
      }
      const summary = summarizeToolResult(block);
      const prefix = block.is_error ? "✗" : "←";
      onChunk(squadName ? `\n[${prefix} ${squadName}: ${summary}]\n` : `\n[${prefix} ${summary}]\n`);
    };

    const handleEvent = (ev: CliEvent) => {
      const t = ev.type;
      if (t === "stream_event" && ev.event) {
        const inner = ev.event;
        const idx = typeof inner.index === "number" ? inner.index : -1;

        // Tool use: block opens with name+id, then receives streaming JSON
        // input deltas, then closes. We render a single marker at close.
        if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
          const name = inner.content_block.name ?? "tool";
          const id = inner.content_block.id;
          if (id) toolNamesById.set(id, name);
          if (idx >= 0) pendingTools.set(idx, { name, input: "" });
          return;
        }
        if (
          inner.type === "content_block_delta" &&
          inner.delta?.type === "input_json_delta" &&
          idx >= 0
        ) {
          const pending = pendingTools.get(idx);
          if (pending && typeof inner.delta.partial_json === "string") {
            pending.input += inner.delta.partial_json;
          }
          return;
        }
        if (inner.type === "content_block_stop" && idx >= 0) {
          const pending = pendingTools.get(idx);
          if (pending) {
            // We don't have the id at this point — `content_block_stop`
            // omits it. Pull the most recent id we associated with this
            // name, if any, so the marker collates with the matching
            // tool_result later.
            let id: string | undefined;
            for (const [tid, tname] of toolNamesById) {
              if (tname === pending.name) id = tid;
            }
            emitToolStart(pending.name, pending.input, id);
            pendingTools.delete(idx);
          }
          return;
        }

        if (
          inner.type === "content_block_delta" &&
          inner.delta?.type === "text_delta" &&
          typeof inner.delta.text === "string"
        ) {
          deltaText += inner.delta.text;
          onChunk(inner.delta.text);
        }

        // Extended-thinking deltas — the model's reasoning, emitted right
        // before each tool call. Stream them through onChunk so the user
        // can see *why* a tool is being called (right before the tool-call
        // card appears in the UI), and aggregate into `thinkingContent`
        // for any consumer that wants the reasoning separately. We do NOT
        // add this to `deltaText` (= persisted assistant text) — replaying
        // verbose narration back as prior-turn context would drag every
        // future call toward over-explaining.
        if (
          inner.type === "content_block_delta" &&
          inner.delta?.type === "thinking_delta" &&
          typeof inner.delta.thinking === "string"
        ) {
          const t = inner.delta.thinking;
          if (t.length > 0) {
            thinkingContent = (thinkingContent ?? "") + t;
            onChunk(t);
          }
        }
        return;
      }

      // Top-level message events — emitted once a turn completes. Use them
      // as a fallback in case the streaming events were missed, and as the
      // canonical source for tool_result blocks (which arrive inside `user`
      // messages between agent loop turns).
      if (t === "assistant" || t === "user") {
        const msg = ev.message as CliAssistantMessage | undefined;
        const content = msg && Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block?.type === "tool_use") {
            const name = block.name ?? "tool";
            if (block.id) toolNamesById.set(block.id, name);
            const inputStr =
              block.input === undefined ? "" : JSON.stringify(block.input);
            emitToolStart(name, inputStr, block.id);
          } else if (block?.type === "tool_result") {
            emitToolResult(block);
          }
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
  /**
   * Explicit override of which tool patterns the CLI may run. When set,
   * takes precedence over the per-call `params.tools` mapping. When
   * undefined, the client derives the pattern list from `params.tools`.
   */
  private readonly allowedToolsOverride: string | undefined;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly executor: SquadToolExecutor | undefined;
  private readonly activeToolsGetter:
    | (() => ToolDefinition[] | undefined)
    | undefined;

  constructor(options: ClaudeCliClientOptions = {}, spawnFn: SpawnFn = spawn) {
    this.oauthToken = options.oauthToken;
    this.binary = options.binary ?? "claude";
    this.cwd = options.cwd ?? process.cwd();
    this.allowedToolsOverride = options.allowedTools;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.spawnFn = spawnFn;
    this.executor = options.executeTool;
    this.activeToolsGetter = options.getActiveTools;
  }

  /**
   * Decide what the CLI subprocess should be allowed to see this turn:
   *   - `ccBuiltinSpec`: value for `--tools`. Empty string disables all
   *     built-ins; a comma-separated list enables exactly those names;
   *     `"default"` enables Claude Code's full built-in toolbox.
   *   - `mcpTools`: squad tools without a CC equivalent — routed through
   *     the per-call MCP bridge when an executor is available, dropped
   *     otherwise.
   *
   * Explicit `allowedToolsOverride` short-circuits the mapping entirely
   * (used for `"*"` = enable everything, `""` = block everything, or a
   * raw tool list).
   */
  private classifyTools(params: CreateMessageParams): {
    ccBuiltinSpec: string;
    mcpTools: ToolDefinition[];
  } {
    if (this.allowedToolsOverride !== undefined) {
      const spec =
        this.allowedToolsOverride === OVERRIDE_ALL
          ? "default"
          : this.allowedToolsOverride;
      return { ccBuiltinSpec: spec, mcpTools: [] };
    }
    const tools = params.tools ?? [];
    const ccBuiltins = new Set<string>();
    const unmapped: ToolDefinition[] = [];
    for (const t of tools) {
      const cc = SQUAD_TO_CC_TOOL_MAP[t.name];
      if (cc) ccBuiltins.add(cc);
      else unmapped.push(t);
    }
    const useMcp = unmapped.length > 0 && this.executor !== undefined;
    return {
      ccBuiltinSpec: [...ccBuiltins].join(","),
      mcpTools: useMcp ? unmapped : [],
    };
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

    // Resolve which CC built-ins the model can see this turn.
    //
    // Precedence:
    //   1. Explicit `allowedTools` on the client (full override — config
    //      knob). `"*"` → all built-ins; `""` → none; anything else passed
    //      verbatim as the `--tools` value.
    //   2. `params.tools` from the runner: each squad tool either maps to
    //      a CC built-in via SQUAD_TO_CC_TOOL_MAP (added to `--tools`), or
    //      routes through the per-call MCP bridge when an executor is
    //      configured.
    //   3. No built-ins (empty `--tools ""`) — pure text completion mode.
    const { ccBuiltinSpec, mcpTools } = this.classifyTools(params);

    let bridge: BridgeResources | null = null;
    if (mcpTools.length > 0 && this.executor) {
      // Hold the bridge's MCP tool set in a mutable ref so the
      // `getActiveTools` callback can grow it mid-run (e.g. when the
      // model unlocks a lazy tool group via `describe_tool_group`) and
      // the next `tools/list` reflects the change.
      const mcpToolsRef: { current: ToolDefinition[] } = { current: mcpTools };
      const getter = this.activeToolsGetter;
      const refreshTools = getter
        ? (): boolean => {
            const all = getter();
            if (!all) return false;
            const next = all.filter((t) => !SQUAD_TO_CC_TOOL_MAP[t.name]);
            const prev = mcpToolsRef.current;
            if (prev.length === next.length) {
              const prevNames = new Set(prev.map((t) => t.name));
              if (next.every((t) => prevNames.has(t.name))) return false;
            }
            mcpToolsRef.current = next;
            return true;
          }
        : undefined;
      bridge = setupMcpBridge(
        () => mcpToolsRef.current,
        this.executor,
        refreshTools,
        (err) => {
          // Log via stderr — the gateway scrapes child stderr already, so
          // the error surfaces in the same channel as other CLI diagnostics.
          process.stderr.write(`squad-mcp-bridge: ${err.message}\n`);
        },
      );
    }

    // The model can actually do something this turn iff some built-in is
    // enabled or the MCP bridge is up. Used to decide whether to auto-
    // approve tool calls (no human present to answer permission prompts).
    const anyToolsEnabled = ccBuiltinSpec.length > 0 || bridge !== null;

    const args: string[] = [...DEFAULT_BASE_ARGS, "--model", params.model];
    // `--tools` is the proper enablement knob — controls what built-ins
    // exist at all, not just what's auto-approved. Empty string disables
    // every built-in, so the model never sees Read/Bash/TodoWrite/etc.
    args.push("--tools", ccBuiltinSpec);
    if (bridge) {
      // `--strict-mcp-config` would lock the CLI to just our generated
      // file, but it's a newer flag and older `claude` binaries error on
      // unknown flags. The per-call mcp.json only declares the squad
      // server anyway, so dropping it doesn't widen the tool surface.
      args.push("--mcp-config", bridge.mcpConfigPath);
    }
    if (anyToolsEnabled) {
      // Auto-approve everything that's been enabled — there's no human at
      // the other end of this subprocess to grant permission prompts.
      args.push("--permission-mode", "bypassPermissions");
    }

    const systemPrompt = params.system ?? "";
    if (systemPrompt.length > 0) {
      args.push("--append-system-prompt", systemPrompt);
    }

    const stdinPayload = buildTranscript(params.messages);
    const env = buildEnv(this.oauthToken);

    try {
      const result = await runCli(
        this.binary,
        args,
        stdinPayload,
        env,
        this.cwd,
        this.timeoutMs,
        this.spawnFn,
        onChunk,
        params.onToolEvent,
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
    } finally {
      if (bridge) bridge.cleanup();
    }
  }
}

// Exposed for unit tests that want to assert on the no-tools sentinel without
// importing the file twice.
export const __INTERNAL = {
  OVERRIDE_ALL,
  CLEAR_ENV,
  DEFAULT_BASE_ARGS,
  SQUAD_TO_CC_TOOL_MAP,
  buildTranscript,
  buildEnv,
  detectAuthError,
};
