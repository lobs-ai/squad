import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMClient, LLMResponse, CreateMessageParams } from "@squad/llm";
import { openDb, type DatabaseHandle } from "./db/index.js";
import { SessionStore } from "./db/sessions.js";
import { TitleGenerator } from "./title-generator.js";

class StubClient implements LLMClient {
  readonly seenModels: string[] = [];
  constructor(private readonly reply: string) {}
  async createMessage(p: CreateMessageParams): Promise<LLMResponse> {
    this.seenModels.push(p.model);
    return {
      content: [{ type: "text", text: this.reply }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
} as unknown as import("./logger.js").Logger;

function makeGen(opts: {
  sessions: SessionStore;
  client: LLMClient;
  enabled?: boolean;
  configuredModel?: string | null;
}): TitleGenerator {
  return new TitleGenerator({
    sessions: opts.sessions,
    logger: silentLogger,
    defaultModel: "default-model",
    enabled: () => opts.enabled ?? true,
    configuredModel: () => opts.configuredModel ?? null,
    resolveConfig: () => ({ clientConfig: {}, resolved: [], missingKeys: [], keyPools: {} }),
    // Tests use the override seam so a single stub intercepts every path
    // (default + explicit-title-model). Production wires `sharedClient`
    // instead; createClient takes the explicit-override case.
    clientOverride: opts.client,
  });
}

describe("TitleGenerator", () => {
  let tmp: string;
  let db: DatabaseHandle;
  let sessions: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "squad-titlegen-"));
    db = openDb({ path: join(tmp, "db.sqlite") });
    sessions = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("titles a session from the first user message", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("Refactoring the auth middleware");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "help me refactor auth");
    expect(sessions.get(s.id).title).toBe("Refactoring the auth middleware");
  });

  it("does not run when enabled() is false", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("never-set");
    await makeGen({ sessions, client, enabled: false }).generateIfNeeded(s.id, "hi");
    expect(sessions.get(s.id).title).toBeNull();
    expect(client.seenModels).toHaveLength(0);
  });

  it("uses configuredModel over the session's primary model", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("ok");
    await makeGen({
      sessions,
      client,
      configuredModel: "cheap-title-model",
    }).generateIfNeeded(s.id, "anything");
    expect(client.seenModels[0]).toBe("cheap-title-model");
  });

  it("falls back to the session model when no configured model is set", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("ok");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(client.seenModels[0]).toBe("session-model");
  });

  it("skips when the session already has a real title", async () => {
    const s = sessions.create({ model: "session-model", title: "User-picked title" });
    const client = new StubClient("Replacement");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(sessions.get(s.id).title).toBe("User-picked title");
    expect(client.seenModels).toHaveLength(0);
  });

  it("treats placeholder titles like 'cli' as missing", async () => {
    const s = sessions.create({ model: "session-model", title: "cli" });
    const client = new StubClient("Real Topic");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(sessions.get(s.id).title).toBe("Real Topic");
  });

  it("does not overwrite a title set concurrently with the LLM call", async () => {
    const s = sessions.create({ model: "session-model" });
    const client: LLMClient = {
      async createMessage() {
        // While the call is in flight, a user renames the session.
        sessions.setTitle(s.id, "User typed this");
        return {
          content: [{ type: "text", text: "LLM answer" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(sessions.get(s.id).title).toBe("User typed this");
  });

  it("strips wrapping quotes and trailing punctuation from the model output", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient(`"My Title."`);
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(sessions.get(s.id).title).toBe("My Title");
  });

  it("ignores empty seeds without burning an LLM call", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("never");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "   ");
    expect(sessions.get(s.id).title).toBeNull();
    expect(client.seenModels).toHaveLength(0);
  });

  it("leaves the session untitled when every LLM candidate fails", async () => {
    const s = sessions.create({ model: "session-model" });
    const client: LLMClient = {
      async createMessage() {
        throw new Error("provider down");
      },
    };
    await makeGen({ sessions, client }).generateIfNeeded(
      s.id,
      "help me refactor the auth middleware.",
    );
    // No seed-text fallback — a truncated first message is a worse title
    // than (untitled), and masks real provider failures.
    expect(sessions.get(s.id).title).toBeNull();
  });

  it("honors per-session titleModel over the configured one", async () => {
    const s = sessions.create({ model: "session-model" });
    sessions.setTitleModel(s.id, "session-title-model");
    const client = new StubClient("ok");
    await makeGen({
      sessions,
      client,
      configuredModel: "config-title-model",
    }).generateIfNeeded(s.id, "anything");
    expect(client.seenModels[0]).toBe("session-title-model");
  });

  it("falls back to the shared client when the explicit title model can't be built", async () => {
    // No env keys + unknown provider → parseModelString throws inside
    // createClient. The shared client (chat primary) catches the title
    // generation so the user still gets a real LLM-generated title.
    const s = sessions.create({ model: "claude-sonnet-4-5" });
    const sharedCalls: string[] = [];
    const sharedClient: LLMClient = {
      async createMessage(p) {
        sharedCalls.push(p.model);
        return {
          content: [{ type: "text", text: "Refactoring auth middleware" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    const gen = new TitleGenerator({
      sessions,
      logger: silentLogger,
      defaultModel: "claude-sonnet-4-5",
      enabled: () => true,
      configuredModel: () => "no-such-provider/no-such-model",
      resolveConfig: () => ({ clientConfig: {}, resolved: [], missingKeys: [], keyPools: {} }),
      sharedClient,
    });
    await gen.generateIfNeeded(s.id, "anything");
    expect(sessions.get(s.id).title).toBe("Refactoring auth middleware");
    expect(sharedCalls).toEqual(["claude-sonnet-4-5"]);
  });

  it("uses 1024 maxTokens so reasoning-model `<think>` blocks have room to finish", async () => {
    // Regression: minimax / deepseek-r1 / GLM emit `<think>...</think>`
    // before the answer. With a tight 40-token budget the think block gets
    // truncated, `stripReasoning` strips the unterminated trailer, and the
    // title comes back empty — making auto-title silently broken on every
    // reasoning-model setup.
    const s = sessions.create({ model: "session-model" });
    let seenMaxTokens = -1;
    const client: LLMClient = {
      async createMessage(p) {
        seenMaxTokens = p.maxTokens;
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(seenMaxTokens).toBe(1024);
  });

  it("strips the provider prefix from the model passed to the SDK", async () => {
    // Regression: previously we forwarded `"anthropic/claude-sonnet-4-5"`
    // straight through, which the provider SDKs 400 on — they want the bare
    // model id. With most configs using `provider/model-id` form, this
    // silently broke every title call and pushed sessions onto the
    // seed-text fallback.
    const s = sessions.create({ model: "anthropic/claude-sonnet-4-5" });
    const client = new StubClient("Topic name");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "anything");
    expect(client.seenModels[0]).toBe("claude-sonnet-4-5");
    expect(sessions.get(s.id).title).toBe("Topic name");
  });

  it("rejects markdown-document replies instead of slicing them into a title", async () => {
    // Regression: when the model ignored the instruction and started
    // answering ("# Squad Cron Jobs Explained\n## What Are Cron Jobs?\n…"),
    // the old sanitize would just hard-cap to 60 chars and produce
    // "# Squad Cron Jobs Explained## What Are Cron Jobs?Cron jo".
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient(
      "# Squad Cron Jobs Explained\n## What Are Cron Jobs?\nCron jobs are scheduled tasks…",
    );
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "explain cron jobs in squad");
    expect(sessions.get(s.id).title).toBeNull();
  });

  it("strips a leading markdown heading marker from an otherwise valid title", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("# Cron Jobs Overview");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "explain cron jobs");
    expect(sessions.get(s.id).title).toBe("Cron Jobs Overview");
  });

  it("keeps only the first line when the model adds a trailing explanation", async () => {
    const s = sessions.create({ model: "session-model" });
    const client = new StubClient("Cron Jobs Overview\n\nThis title summarizes the topic.");
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "explain cron jobs");
    expect(sessions.get(s.id).title).toBe("Cron Jobs Overview");
  });

  it("leaves the session untitled when the LLM returns no usable text", async () => {
    const s = sessions.create({ model: "session-model" });
    const client: LLMClient = {
      async createMessage() {
        return {
          content: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    await makeGen({ sessions, client }).generateIfNeeded(s.id, "investigate the queue backlog");
    expect(sessions.get(s.id).title).toBeNull();
  });
});
