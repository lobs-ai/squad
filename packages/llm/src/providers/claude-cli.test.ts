import { describe, it, expect } from "vitest";
import { EventEmitter, Readable, Writable } from "node:stream";
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
}): {
  fn: SpawnFn;
  calls: Array<{
    binary: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdin: string;
  }>;
} {
  const calls: Array<{
    binary: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    stdin: string;
  }> = [];

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
        });
        child.emit("close", opts.exitCode ?? 0);
      };
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

  return { fn, calls };
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

  it("locks built-in tools off by default via --allowedTools", async () => {
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
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(__INTERNAL.NO_TOOLS_PATTERN);
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
