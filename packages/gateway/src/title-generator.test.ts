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
  fallbackModel?: string | null;
}): TitleGenerator {
  return new TitleGenerator({
    sessions: opts.sessions,
    logger: silentLogger,
    defaultModel: "default-model",
    enabled: () => opts.enabled ?? true,
    configuredModel: () => opts.configuredModel ?? null,
    fallbackModel: () => opts.fallbackModel ?? null,
    resolveConfig: () => ({ clientConfig: {}, resolved: [], missingKeys: [], keyPools: {} }),
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
});
