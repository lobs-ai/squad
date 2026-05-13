import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter, Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import type { ChildProcess } from "node:child_process";
import { ClaudeCliClient, __INTERNAL } from "./claude-cli.js";
import type { SpawnFn } from "./claude-cli.js";

/**
 * Build a fake `spawn` that emits a scripted sequence of JSONL strings on
 * stdout, an optional stderr blob, and exits with the given code. The
 * returned helper also captures the args, env, and stdin written by the
 * subject under test so assertions can check the constructed command shape.
 */
function makeFakeSpawn(opts: {
  stdoutLines: string[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  spawnError?: NodeJS.ErrnoException;
  /** When true, the child does not auto-emit `close`. Tests trigger it via `release()`. */
  holdOpen?: boolean;
}): {
  fn: SpawnFn;
  calls: Array<{
    binary: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdin: string;
    /** Parsed contents of `--mcp-config <path>` captured at spawn time, before bridge cleanup. */
    mcpConfig?: { mcpServers?: Record<string, { command: string; args: string[] }> };
  }>;
  /**
   * Populated synchronously when spawn is invoked — gives the test access
   * to args + mcp config before the (potentially short-lived) bridge has
   * been torn down by the call's `finally` cleanup.
   */
  liveCalls: Array<{
    args: string[];
    mcpConfig?: { mcpServers?: Record<string, { command: string; args: string[] }> };
  }>;
  /** Release any pending child(ren) — fires their `close` event. No-op for non-holdOpen spawns. */
  release: () => void;
} {
  const calls: Array<{
    binary: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdin: string;
    mcpConfig?: { mcpServers?: Record<string, { command: string; args: string[] }> };
  }> = [];
  const liveCalls: Array<{
    args: string[];
    mcpConfig?: { mcpServers?: Record<string, { command: string; args: string[] }> };
  }> = [];
  const pending = new Set<() => void>();

  const fn = ((binary: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let stdinPayload = "";
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        stdinPayload += chunk.toString();
        cb();
      },
      final(cb) {
        cb();
      },
    });

    (child as unknown as { stdout: Readable }).stdout = stdout;
    (child as unknown as { stderr: Readable }).stderr = stderr;
    (child as unknown as { stdin: Writable }).stdin = stdin;
    (child as unknown as { kill: () => void }).kill = () => {
      /* no-op in tests */
    };

    // Capture metadata that the bridge cleanup will later wipe (mcp.json).
    // Has to happen synchronously here so it survives the finally-block
    // `bridge.cleanup()` that runs as soon as the call resolves.
    let mcpConfig: { mcpServers?: Record<string, { command: string; args: string[] }> } | undefined;
    const cfgIdx = args.indexOf("--mcp-config");
    if (cfgIdx >= 0) {
      const path = args[cfgIdx + 1];
      try {
        mcpConfig = JSON.parse(readFileSync(path!, "utf8")) as typeof mcpConfig;
      } catch {
        /* mcp.json not yet written or already gone */
      }
    }
    liveCalls.push({ args: [...args], ...(mcpConfig ? { mcpConfig } : {}) });

    queueMicrotask(() => {
      if (opts.spawnError) {
        child.emit("error", opts.spawnError);
        return;
      }
      for (const line of opts.stdoutLines) {
        stdout.push(line.endsWith("\n") ? line : `${line}\n`);
      }
      if (opts.stderr) stderr.push(opts.stderr);
      stdout.push(null);
      stderr.push(null);
      const fire = () => {
        calls.push({
          binary,
          args: [...args],
          env: (options.env as NodeJS.ProcessEnv) ?? {},
          cwd: (options.cwd as string) ?? "",
          stdin: stdinPayload,
          ...(mcpConfig ? { mcpConfig } : {}),
        });
        child.emit("close", opts.exitCode ?? 0);
      };
      if (opts.holdOpen) {
        pending.add(fire);
        return;
      }
      if (opts.exitDelayMs && opts.exitDelayMs > 0) {
        setTimeout(fire, opts.exitDelayMs);
        return;
      }
      // Wait until both stdout & stderr have actually drained — `push(null)`
      // doesn't emit `end` until the reader consumes everything, and we
      // need the `data` events to land before `close` fires for the
      // subject under test to see them.
      let endedCount = 0;
      const onEnded = () => {
        endedCount++;
        if (endedCount === 2) fire();
      };
      stdout.once("end", onEnded);
      stderr.once("end", onEnded);
    });

    return child;
  }) as unknown as SpawnFn;

  const release = (): void => {
    for (const f of pending) f();
    pending.clear();
  };

  return { fn, calls, liveCalls, release };
}

const STREAM_DELTAS = [
  `{"type":"system","session_id":"sess-abc"}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}`,
  `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}`,
  `{"type":"result","result":"Hello world","usage":{"input_tokens":12,"output_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":0}}`,
];

describe("ClaudeCliClient", () => {
  it("rejects when no OAuth token is configured", async () => {
    const { fn } = makeFakeSpawn({ stdoutLines: [] });
    const client = new ClaudeCliClient({}, fn);
    await expect(
      client.createMessage({
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns assembled text + token usage from a successful run", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    const res = await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "You are helpful.",
      messages: [{ role: "user", content: "say hi" }],
      tools: [],
      maxTokens: 100,
    });
    expect(res.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.binary).toBe("claude");
    expect(call.args).toContain("-p");
    expect(call.args).toContain("stream-json");
    expect(call.args).toContain("--model");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
    expect(call.args).toContain("--append-system-prompt");
    expect(call.stdin).toBe("say hi");
  });

  it("streams text deltas through onChunk", async () => {
    const { fn } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    const chunks: string[] = [];
    await client.streamMessage(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
      },
      (t) => chunks.push(t),
    );
    expect(chunks).toEqual(["Hello ", "world"]);
  });

  it("sets CLAUDE_CODE_OAUTH_TOKEN and strips other Claude auth env vars", async () => {
    process.env.ANTHROPIC_API_KEY = "should-be-stripped";
    process.env.ANTHROPIC_BASE_URL = "should-be-stripped-too";
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    try {
      const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
      await client.createMessage({
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
      });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
    const env = calls[0]!.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-xyz");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    // Required for `bypassPermissions` to work when the squad gateway
    // runs as root (the default inside the docker image).
    expect(env.IS_SANDBOX).toBe("1");
  });

  it("renders multi-turn history as a Human/Assistant transcript", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [
        { role: "user", content: "what is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "and 3+3?" },
      ],
      tools: [],
      maxTokens: 100,
    });
    expect(calls[0]!.stdin).toBe(
      "Human: what is 2+2?\n\nAssistant: 4\n\nHuman: and 3+3?",
    );
  });

  it("disables every built-in (--tools \"\") when params.tools is empty and no override", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("");
    // Nothing to permission, so no --permission-mode flag.
    expect(args).not.toContain("--permission-mode");
    // And no `--allowedTools` legacy whitelist anywhere.
    expect(args).not.toContain("--allowedTools");
  });

  it("maps params.tools to a single --tools list via SQUAD_TO_CC_TOOL_MAP", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "read", description: "", input_schema: { type: "object" } },
        { name: "write", description: "", input_schema: { type: "object" } },
        { name: "exec", description: "", input_schema: { type: "object" } },
        { name: "web_search", description: "", input_schema: { type: "object" } },
      ],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThan(-1);
    const enabled = args[idx + 1]!.split(",").sort();
    expect(enabled).toEqual(["Bash", "Read", "WebSearch", "Write"]);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("blocks built-ins (--tools \"\") when none of params.tools map to CC and no MCP executor", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "create_task", description: "", input_schema: { type: "object" } },
        { name: "send_email", description: "", input_schema: { type: "object" } },
      ],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--permission-mode");
  });

  it("explicit allowedTools override beats params.tools (\"*\" → --tools default)", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", allowedTools: "*" },
      fn,
    );
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "", input_schema: { type: "object" } }],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    expect(args[args.indexOf("--tools") + 1]).toBe("default");
  });

  it("does not append any tool-related instructions to the system prompt", async () => {
    // The CLI's --tools flag controls availability at the protocol level,
    // so we no longer need to scold the model with "X is DISABLED" text.
    // params.system passes through verbatim.
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("You are helpful.");
  });

  it("opts into tools when allowedTools='*' and sets bypassPermissions", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", allowedTools: "*" },
      fn,
    );
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "do stuff",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    expect(args[args.indexOf("--tools") + 1]).toBe("default");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("do stuff");
  });

  const TOOL_STREAM_LINES = [
    `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"Read"}}}`,
    `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}}`,
    `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/etc/hosts\\"}"}}}`,
    `{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool_1","content":"127.0.0.1 localhost"}]}}`,
    `{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`,
  ];

  it("surfaces CLI tool activity as structured onToolEvent calls when supplied", async () => {
    // The native model path. With onToolEvent wired, tool_use / tool_result
    // become structured events the runner can broadcast as chat.tool_call /
    // chat.tool_result — same channel a native model would feed.
    const { fn } = makeFakeSpawn({ stdoutLines: TOOL_STREAM_LINES });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", allowedTools: "*" },
      fn,
    );
    const events: Array<Record<string, unknown>> = [];
    const chunks: string[] = [];
    const res = await client.streamMessage(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "read /etc/hosts" }],
        tools: [],
        maxTokens: 100,
        onToolEvent: (ev) => events.push(ev as unknown as Record<string, unknown>),
      },
      (t) => chunks.push(t),
    );
    expect(events).toEqual([
      {
        type: "tool_start",
        toolName: "read", // CC's "Read" → squad's "read"
        toolInput: { path: "/etc/hosts" },
        toolUseId: "tool_1",
      },
      {
        type: "tool_result",
        toolName: "read",
        toolUseId: "tool_1",
        result: "127.0.0.1 localhost",
      },
    ]);
    // Inline markers should NOT also leak into the text stream when the
    // caller is consuming events structurally.
    expect(chunks.join("")).not.toMatch(/\[→/);
    expect(chunks.join("")).not.toMatch(/\[←/);
    expect(res.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("falls back to inline [→ name: input] markers when onToolEvent is absent", async () => {
    const { fn } = makeFakeSpawn({ stdoutLines: TOOL_STREAM_LINES });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", allowedTools: "*" },
      fn,
    );
    const chunks: string[] = [];
    const res = await client.streamMessage(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "read /etc/hosts" }],
        tools: [],
        maxTokens: 100,
      },
      (t) => chunks.push(t),
    );
    const joined = chunks.join("");
    // Markers display the squad-namespaced name so plain-text consumers
    // see "read" rather than "Read".
    expect(joined).toMatch(/\[→ read: \/etc\/hosts\]/);
    expect(joined).toMatch(/\[← read: 127\.0\.0\.1 localhost\]/);
    expect(res.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("streams CLI extended-thinking deltas inline so the reasoning shows up before each tool call", async () => {
    // The user sees *why* the CLI is about to call a tool — the model's
    // pre-call narrative is forwarded through onChunk just like a regular
    // model's streamed reply, and the aggregated reasoning lands in
    // LLMResponse.thinkingContent for any consumer that wants it as a
    // separate field.
    const lines = [
      `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}`,
      `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I should read /etc/hosts "}}}`,
      `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"to answer this."}}}`,
      `{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
      `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"Read"}}}`,
      `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/etc/hosts\\"}"}}}`,
      `{"type":"stream_event","event":{"type":"content_block_stop","index":1}}`,
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool_1","content":"127.0.0.1 localhost"}]}}`,
      `{"type":"result","result":"hosts maps localhost to 127.0.0.1","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`,
    ];
    const { fn } = makeFakeSpawn({ stdoutLines: lines });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", allowedTools: "*" },
      fn,
    );
    const chunks: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const res = await client.streamMessage(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "what's in /etc/hosts?" }],
        tools: [],
        maxTokens: 100,
        onToolEvent: (ev) => events.push(ev as unknown as Record<string, unknown>),
      },
      (t) => chunks.push(t),
    );
    // Reasoning is streamed and arrives BEFORE the tool_start event in the
    // observable order — exactly what a UI would render as "thinking text,
    // then tool card."
    const reasoningChunks = chunks.filter((c) =>
      c.includes("I should read") || c.includes("to answer this"),
    );
    expect(reasoningChunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("I should read /etc/hosts to answer this.");
    // Aggregated thinking surfaces on the response for any consumer that
    // wants it without parsing the stream.
    expect(res.thinkingContent).toBe("I should read /etc/hosts to answer this.");
    // The final assistant content is just the answer — thinking does NOT
    // leak into the persisted assistant message text.
    expect(res.content).toEqual([
      { type: "text", text: "hosts maps localhost to 127.0.0.1" },
    ]);
    // Tool event still fires as before.
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
  });

  it("strips the mcp__squad__ prefix when reporting MCP-bridged tool events", async () => {
    const lines = [
      `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_2","name":"mcp__squad__create_task"}}}`,
      `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"subject\\":\\"x\\"}"}}}`,
      `{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool_2","content":"ok"}]}}`,
      `{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}`,
    ];
    const { fn } = makeFakeSpawn({ stdoutLines: lines });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", allowedTools: "*" },
      fn,
    );
    const events: Array<Record<string, unknown>> = [];
    await client.streamMessage(
      {
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
        onToolEvent: (ev) => events.push(ev as unknown as Record<string, unknown>),
      },
      () => {},
    );
    expect(events[0]).toMatchObject({ type: "tool_start", toolName: "create_task" });
    expect(events[1]).toMatchObject({ type: "tool_result", toolName: "create_task" });
  });

  it("surfaces ENOENT with an install hint", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const { fn } = makeFakeSpawn({ stdoutLines: [], spawnError: err });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await expect(
      client.createMessage({
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
      }),
    ).rejects.toThrow(/npm install -g @anthropic-ai\/claude-code/);
  });

  it("classifies oauth-style error events as 401 auth errors", async () => {
    const lines = [
      `{"type":"result","result":"Authentication failed: please re-run claude setup-token","is_error":true}`,
    ];
    const { fn } = makeFakeSpawn({ stdoutLines: lines, exitCode: 1 });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await expect(
      client.createMessage({
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects with status 408 on timeout", async () => {
    const { fn } = makeFakeSpawn({ stdoutLines: [], exitDelayMs: 200 });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", timeoutMs: 20 },
      fn,
    );
    await expect(
      client.createMessage({
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({ status: 408 });
  });
});

describe("ClaudeCliClient MCP bridge (stage 2)", () => {
  it("spins up an MCP bridge for unmapped tools when executeTool is provided", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient(
      {
        oauthToken: "tok-xyz",
        executeTool: async () => "ok",
      },
      fn,
    );
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "read", description: "", input_schema: { type: "object" } }, // mapped
        { name: "create_task", description: "", input_schema: { type: "object" } }, // unmapped
      ],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    // Mapped tool flows into --tools; unmapped tools route through MCP.
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args).toContain("--mcp-config");
    // mcp.json was captured at spawn time (before the finally-block cleanup
    // removed the temp dir).
    const cfg = calls[0]!.mcpConfig;
    expect(cfg?.mcpServers?.squad?.command).toBe("node");
    expect(cfg?.mcpServers?.squad?.args?.[0]).toMatch(/bridge\.mjs$/);
  });

  it("routes ls and code_search through MCP rather than mapping to Bash/Grep", async () => {
    // ls and code_search look adjacent to Bash/Grep but aren't 1:1 — we
    // route them through squad's executor instead of silently widening
    // the agent's capabilities to full Bash / Grep.
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient(
      { oauthToken: "tok-xyz", executeTool: async () => "ok" },
      fn,
    );
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "ls", description: "", input_schema: { type: "object" } },
        { name: "code_search", description: "", input_schema: { type: "object" } },
      ],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    // No CC built-ins enabled — ls/code_search take the MCP path instead.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--mcp-config");
    const tools = calls[0]!.mcpConfig?.mcpServers?.squad?.args?.[0];
    expect(tools).toMatch(/bridge\.mjs$/);
  });

  it("skips the MCP bridge when no executeTool is configured", async () => {
    const { fn, calls } = makeFakeSpawn({ stdoutLines: STREAM_DELTAS });
    const client = new ClaudeCliClient({ oauthToken: "tok-xyz" }, fn);
    await client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "read", description: "", input_schema: { type: "object" } }, // mapped
        { name: "create_task", description: "", input_schema: { type: "object" } }, // unmapped, dropped
      ],
      maxTokens: 100,
    });
    const args = calls[0]!.args;
    expect(args).not.toContain("--mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
  });

  it("MCP server connection round-trips initialize/tools/list/tools/call", async () => {
    // The fake spawn is held open so the bridge stays alive while the
    // test drives the JSON-RPC protocol over the Unix socket.
    const executorCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const { fn, liveCalls, release } = makeFakeSpawn({
      stdoutLines: STREAM_DELTAS,
      holdOpen: true,
    });

    const client = new ClaudeCliClient(
      {
        oauthToken: "tok-xyz",
        executeTool: async (name, params) => {
          executorCalls.push({ name, params });
          return `result for ${name}`;
        },
      },
      fn,
    );

    const callPromise = client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "create_task",
          description: "Create a new task",
          input_schema: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
      maxTokens: 100,
    });

    // Wait until spawn fires and the fake captures the live mcp.json.
    for (let attempt = 0; attempt < 50 && liveCalls.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cfg = liveCalls[0]?.mcpConfig;
    const socketPath = cfg?.mcpServers?.squad?.args?.[1];
    if (!socketPath) {
      release();
      await callPromise;
      throw new Error("bridge socket path not exposed by fake spawn");
    }

    await new Promise<void>((resolve, reject) => {
      const sock = connect(socketPath!);
      let buffer = "";
      const responses: Record<string, unknown>[] = [];
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          responses.push(JSON.parse(line));
          if (responses.length === 3) {
            sock.end();
            try {
              expect(
                (responses[0] as { result?: { serverInfo?: { name?: string } } }).result
                  ?.serverInfo?.name,
              ).toBe("squad-mcp-bridge");
              const listed =
                (responses[1] as { result?: { tools?: Array<{ name: string }> } }).result
                  ?.tools ?? [];
              expect(listed.map((t) => t.name)).toEqual(["create_task"]);
              const callRes = responses[2] as {
                result?: { content?: Array<{ text?: string }> };
              };
              expect(callRes.result?.content?.[0]?.text).toBe("result for create_task");
              expect(executorCalls).toEqual([
                { name: "create_task", params: { title: "ship it" } },
              ]);
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        }
      });
      sock.on("error", reject);
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      sock.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "create_task", arguments: { title: "ship it" } },
        })}\n`,
      );
    });

    // Let the held-open child close so createMessage resolves and the
    // bridge cleanup runs.
    release();
    await callPromise;
  });

  // Regression: the gateway reads its per-run sessionId from an
  // AsyncLocalStorage frame around createMessage, so the MCP bridge must
  // preserve that frame when the spawned `claude` subprocess connects from
  // outside the parent's async context. Without AsyncResource.bind on the
  // executor, the connection callback runs in the empty root context, the
  // gateway reads sessionId=undefined, and describe_tool_group → unlockGroup
  // silently no-ops (bug: lazy tool groups never become callable).
  it("propagates the caller's AsyncLocalStorage frame into the executor", async () => {
    const storage = new AsyncLocalStorage<{ sessionId: string }>();
    let observedSessionId: string | undefined;

    const { fn, liveCalls, release } = makeFakeSpawn({
      stdoutLines: STREAM_DELTAS,
      holdOpen: true,
    });

    const client = new ClaudeCliClient(
      {
        oauthToken: "tok-xyz",
        executeTool: async () => {
          observedSessionId = storage.getStore()?.sessionId;
          return "ok";
        },
      },
      fn,
    );

    const callPromise = storage.run({ sessionId: "sess-42" }, () =>
      client.createMessage({
        model: "claude-sonnet-4-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "list_tasks",
            description: "",
            input_schema: { type: "object" },
          },
        ],
        maxTokens: 100,
      }),
    );

    for (let attempt = 0; attempt < 50 && liveCalls.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const socketPath = liveCalls[0]?.mcpConfig?.mcpServers?.squad?.args?.[1];
    if (!socketPath) {
      release();
      await callPromise;
      throw new Error("bridge socket path not exposed by fake spawn");
    }

    await new Promise<void>((resolve, reject) => {
      const sock = connect(socketPath);
      sock.setEncoding("utf8");
      let buffer = "";
      let seen = 0;
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          seen++;
          if (seen === 2) {
            sock.end();
            resolve();
          }
        }
      });
      sock.on("error", reject);
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      sock.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_tasks", arguments: {} },
        })}\n`,
      );
    });

    expect(observedSessionId).toBe("sess-42");

    release();
    await callPromise;
  });

  // Lets `describe_tool_group` make its newly-unlocked tools callable on
  // the very next iteration of the CLI's internal loop. The bridge must:
  //   (1) advertise capabilities.tools.listChanged: true at init,
  //   (2) re-query getTools() on every tools/list (not snapshot at start),
  //   (3) emit notifications/tools/list_changed after a tools/call when
  //       the supplied refresh callback reports the set changed.
  it("emits notifications/tools/list_changed when getActiveTools widens", async () => {
    const { fn, liveCalls, release } = makeFakeSpawn({
      stdoutLines: STREAM_DELTAS,
      holdOpen: true,
    });

    // The "live" tool set the gateway would compute from session state.
    // Starts as just the meta tool; the simulated tools/call below
    // "unlocks" the tasks group by widening this list.
    let activeTools: import("../types.js").ToolDefinition[] = [
      { name: "describe_tool_group", description: "", input_schema: { type: "object" } },
    ];

    const client = new ClaudeCliClient(
      {
        oauthToken: "tok-xyz",
        executeTool: async (name) => {
          if (name === "describe_tool_group") {
            activeTools = [
              { name: "describe_tool_group", description: "", input_schema: { type: "object" } },
              { name: "list_tasks", description: "", input_schema: { type: "object" } },
              { name: "create_task", description: "", input_schema: { type: "object" } },
            ];
          }
          return "ok";
        },
        getActiveTools: () => activeTools,
      },
      fn,
    );

    const callPromise = client.createMessage({
      model: "claude-sonnet-4-5",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      // Bridge's initial mcpTools — only describe_tool_group is in scope
      // at call start; everything else has to come online via the refresh.
      tools: [
        { name: "describe_tool_group", description: "", input_schema: { type: "object" } },
      ],
      maxTokens: 100,
    });

    for (let attempt = 0; attempt < 50 && liveCalls.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const socketPath = liveCalls[0]?.mcpConfig?.mcpServers?.squad?.args?.[1];
    if (!socketPath) {
      release();
      await callPromise;
      throw new Error("bridge socket path not exposed by fake spawn");
    }

    await new Promise<void>((resolve, reject) => {
      const sock = connect(socketPath);
      sock.setEncoding("utf8");
      let buffer = "";
      const frames: Record<string, unknown>[] = [];
      let phase: "before" | "after" = "before";
      let listChangedSeen = false;
      let firstListNames: string[] = [];
      let secondListNames: string[] = [];

      sock.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const frame = JSON.parse(line) as Record<string, unknown>;
          frames.push(frame);

          if (frame.method === "notifications/tools/list_changed") {
            listChangedSeen = true;
            // Re-fetch tools/list to confirm the new set is visible.
            sock.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" })}\n`,
            );
            phase = "after";
            return;
          }

          if (frame.id === 1) {
            // initialize response
            const caps = (frame.result as { capabilities?: { tools?: { listChanged?: boolean } } })
              ?.capabilities;
            try {
              expect(caps?.tools?.listChanged).toBe(true);
            } catch (e) {
              reject(e);
              return;
            }
          }

          if (frame.id === 2) {
            firstListNames = (
              (frame.result as { tools?: Array<{ name: string }> }).tools ?? []
            ).map((t) => t.name);
            sock.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "describe_tool_group", arguments: { groups: "tasks" } },
              })}\n`,
            );
          }

          if (frame.id === 99 && phase === "after") {
            secondListNames = (
              (frame.result as { tools?: Array<{ name: string }> }).tools ?? []
            ).map((t) => t.name);
            sock.end();
            try {
              expect(listChangedSeen).toBe(true);
              expect(firstListNames).toEqual(["describe_tool_group"]);
              expect(secondListNames.sort()).toEqual(
                ["create_task", "describe_tool_group", "list_tasks"].sort(),
              );
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        }
      });
      sock.on("error", reject);
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    });

    release();
    await callPromise;
  });
});

describe("ClaudeCliClient internals", () => {
  it("detectAuthError matches common auth signals", () => {
    expect(__INTERNAL.detectAuthError("HTTP 401 Unauthorized")).toBe(true);
    expect(__INTERNAL.detectAuthError("Invalid API key")).toBe(true);
    expect(__INTERNAL.detectAuthError("OAuth token expired")).toBe(true);
    expect(__INTERNAL.detectAuthError("rate limit")).toBe(false);
  });

  it("buildTranscript passes a single user string through unchanged", () => {
    expect(
      __INTERNAL.buildTranscript([{ role: "user", content: "hi" }]),
    ).toBe("hi");
  });
});
