import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenAICodexClient,
  CodexProviderError,
  __INTERNAL,
} from "./openai-codex.js";
import { CodexAuthService } from "./openai-codex-auth.js";
import type { LLMMessage } from "../types.js";

// ── conversion ───────────────────────────────────────────────────────────────

describe("convertMessagesToInput", () => {
  const { convertMessagesToInput } = __INTERNAL;

  it("emits a single user input_text entry for a simple string turn", () => {
    const input = convertMessagesToInput([{ role: "user", content: "hello" }]);
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  it("hoists tool_result blocks to top-level function_call_output frames", () => {
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_42", content: "tool output" },
          { type: "text", text: "follow-up text" },
        ],
      },
    ];
    const input = convertMessagesToInput(messages);
    // tool_result is hoisted to its own frame; the text is kept under the user.
    expect(input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_42",
      output: "tool output",
    });
    expect(input[1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "follow-up text" }],
    });
  });

  it("prefixes assistant tool_use ids with fc_ when needed", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_abc", name: "read", input: { path: "/x" } },
        ],
      },
    ];
    const input = convertMessagesToInput(messages);
    expect(input).toEqual([
      {
        type: "function_call",
        call_id: "call_abc",
        id: "fc_call_abc",
        name: "read",
        arguments: '{"path":"/x"}',
      },
    ]);
  });
});

// ── SSE parsing ──────────────────────────────────────────────────────────────

describe("extractFinalFromSSE", () => {
  const { extractFinalFromSSE } = __INTERNAL;

  it("returns the response from a `response.completed` event", () => {
    const sse =
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          output: [
            { type: "message", content: [{ type: "output_text", text: "hi there" }] },
          ],
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })}\n\n`;
    const final = extractFinalFromSSE(sse);
    expect(final.status).toBe("completed");
    expect(final.usage?.input_tokens).toBe(10);
  });

  it("throws CodexProviderError when SSE contains response.failed", () => {
    const sse =
      `data: ${JSON.stringify({
        type: "response.failed",
        response: { error: { message: "rate limited" } },
      })}\n\n`;
    expect(() => extractFinalFromSSE(sse)).toThrow(/rate limited/);
  });

  it("calls onChunk for response.output_text.delta events", () => {
    const sse =
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hel" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n` +
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { output: [], status: "completed" },
      })}\n\n`;
    const chunks: string[] = [];
    extractFinalFromSSE(sse, (c) => chunks.push(c));
    expect(chunks).toEqual(["hel", "lo"]);
  });
});

// ── fetch shape ──────────────────────────────────────────────────────────────

describe("OpenAICodexClient.createMessage", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a Responses-API body with Bearer + account headers, and parses the SSE response", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      const sse =
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "hi from codex" }],
              },
            ],
            status: "completed",
            usage: { input_tokens: 4, output_tokens: 6 },
          },
        })}\n\n`;
      return new Response(sse, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new OpenAICodexClient({
      tokenProvider: {
        getAccessToken: async () => "tok_xyz",
        getAccountId: () => "acct-123",
      },
      sessionId: "sess-1",
    });
    const res = await client.createMessage({
      model: "gpt-5-codex",
      system: "be brief",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      maxTokens: 256,
    });

    expect(res.content).toEqual([{ type: "text", text: "hi from codex" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage.inputTokens).toBe(4);

    // Endpoint, auth, and account headers all wired correctly.
    expect(captured.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok_xyz");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    expect(headers["session_id"]).toBe("sess-1");

    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe("gpt-5-codex");
    expect(body.stream).toBe(true);
    expect(body.prompt_cache_key).toBe("sess-1");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "ping" }] },
    ]);
  });

  it("forces a refresh and retries once on 401", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("expired", { status: 401 });
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { output: [], status: "completed" },
        })}\n\n`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const forceRefresh = vi.fn(async () => {});
    const client = new OpenAICodexClient({
      tokenProvider: {
        getAccessToken: async () => "tok",
        forceRefresh,
      },
    });
    await client.createMessage({
      model: "gpt-5-codex",
      system: "",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      maxTokens: 1,
    });
    expect(calls).toBe(2);
    expect(forceRefresh).toHaveBeenCalledOnce();
  });

  it("surfaces non-401 errors as CodexProviderError", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;
    const client = new OpenAICodexClient({
      tokenProvider: { getAccessToken: async () => "tok" },
    });
    await expect(
      client.createMessage({
        model: "gpt-5-codex",
        system: "",
        messages: [{ role: "user", content: "x" }],
        tools: [],
        maxTokens: 1,
      }),
    ).rejects.toBeInstanceOf(CodexProviderError);
  });
});

// ── CodexAuthService persistence ────────────────────────────────────────────

describe("CodexAuthService", () => {
  let tmp: string;
  let credsPath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codex-auth-"));
    credsPath = join(tmp, "creds.json");
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it("loads creds from disk and returns the cached access token when fresh", async () => {
    // Pre-populate a creds file with a JWT that doesn't expire for an hour.
    const future = Math.floor((Date.now() + 60 * 60_000) / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "none" }));
    const payload = base64UrlEncode(
      JSON.stringify({
        exp: future,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
      }),
    );
    const fakeJwt = `${header}.${payload}.sig`;
    writeFileSync(
      credsPath,
      JSON.stringify({
        access: fakeJwt,
        refresh: "rt_existing",
        expires: Date.now() + 60 * 60_000,
        accountId: "acct-test",
      }),
    );

    const auth = new CodexAuthService({ credsPath });
    expect(auth.hasCredentials()).toBe(true);
    expect(await auth.getAccessToken()).toBe(fakeJwt);
    expect(auth.getAccountId()).toBe("acct-test");
  });

  it("uses the boot refresh token over the cached one, persisting the new creds", async () => {
    // Cached creds carry a different (stale) refresh token.
    writeFileSync(
      credsPath,
      JSON.stringify({
        access: "stale_access",
        refresh: "rt_old",
        expires: Date.now() - 1000, // expired so refresh runs
      }),
    );

    let receivedRefresh: string | undefined;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      receivedRefresh = params.get("refresh_token") ?? undefined;
      const accessJwt = makeFakeJwt({ accountId: "acct-fresh" });
      return new Response(
        JSON.stringify({
          access_token: accessJwt,
          refresh_token: "rt_rotated",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const auth = new CodexAuthService({
      credsPath,
      refreshToken: "rt_boot",
    });
    const token = await auth.getAccessToken();
    expect(receivedRefresh).toBe("rt_boot");
    expect(token).toMatch(/^ey/);
    expect(auth.getAccountId()).toBe("acct-fresh");
    // Persisted creds reflect the rotated refresh token.
    const persisted = JSON.parse(readFileSync(credsPath, "utf-8"));
    expect(persisted.refresh).toBe("rt_rotated");
  });

  it("dedups concurrent refresh callers", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      // Make refresh slow so the second caller arrives while it's in-flight.
      await new Promise((r) => setTimeout(r, 25));
      const accessJwt = makeFakeJwt({ accountId: "acct-fresh" });
      return new Response(
        JSON.stringify({
          access_token: accessJwt,
          refresh_token: "rt_rotated",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const auth = new CodexAuthService({
      credsPath,
      refreshToken: "rt_boot",
    });
    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("throws when no refresh token is available", async () => {
    const auth = new CodexAuthService({ credsPath });
    await expect(auth.getAccessToken()).rejects.toThrow(/no refresh_token/);
  });

  it("persists nothing when the directory is unwritable but still returns a token", async () => {
    // Point the creds file at a path inside a non-existent parent that mkdirSync
    // can't fix (because the grandparent doesn't exist either) — actually
    // mkdirSync recursive will fix any depth, so simulate with a file that
    // already exists in place of the parent directory.
    const blocker = join(tmp, "blocker");
    writeFileSync(blocker, "I'm a file, not a directory");
    const bad = new CodexAuthService({
      credsPath: join(blocker, "child", "creds.json"),
      refreshToken: "rt_boot",
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: makeFakeJwt({ accountId: "acct-fresh" }),
          refresh_token: "rt_rotated",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const token = await bad.getAccessToken();
    expect(token).toMatch(/^ey/);
    expect(existsSync(join(blocker, "child", "creds.json"))).toBe(false);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeFakeJwt(opts: { accountId: string }): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      exp: Math.floor((Date.now() + 60 * 60_000) / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: opts.accountId },
    }),
  );
  return `${header}.${payload}.sig`;
}
