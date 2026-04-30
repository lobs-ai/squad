import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { AddArgs, IngestResult, MemCore } from "memcore";

import { openDb, type DatabaseHandle } from "../db/index.js";
import { SessionStore } from "../db/sessions.js";
import { MessageStore } from "../db/messages.js";
import { MemoryService } from "./service.js";
import { SessionIngestionService } from "./session-ingest.js";
import { StubMemCore } from "../../test/fixtures/stub-memcore.js";

const logger = pino({ level: "silent" });

interface AddCall {
  args: AddArgs;
  result: IngestResult;
}

class RecordingMemCore extends StubMemCore {
  readonly calls: AddCall[] = [];
  failNext = 0;

  override async add(args: AddArgs): Promise<IngestResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated extraction failure");
    }
    const result = await super.add(args);
    // Reflect a non-zero memoriesWritten for extract:true so logs and tests
    // can distinguish "extracted nothing" from "wrote N atoms."
    if (args.extract !== false) {
      result.memoriesWritten = 2;
      result.chunksWritten = 1;
    }
    this.calls.push({ args, result });
    return result;
  }
}

interface Fixtures {
  dataDir: string;
  db: DatabaseHandle;
  sessions: SessionStore;
  messages: MessageStore;
  memcore: RecordingMemCore;
  memoryService: MemoryService;
  ingestion: SessionIngestionService;
}

function setup(): Fixtures {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-ingest-"));
  const db = openDb({ path: join(dataDir, "gateway.db") });
  const sessions = new SessionStore(db);
  const messages = new MessageStore(db);
  const memcore = new RecordingMemCore();
  const memoryService = new MemoryService(memcore as unknown as MemCore, logger, {
    containerTag: "test",
  });
  const ingestion = new SessionIngestionService({
    memcore: memcore as unknown as MemCore,
    sessions,
    messages,
    memoryService,
    logger,
    containerTag: "test",
    config: {
      idleThresholdSeconds: 0, // sweeper picks any session immediately
      maxIdleSeconds: 60_000,
      minDeltaMessages: 0,
      minDeltaTokens: 0,
      includeSubagents: false,
      sweeperIntervalSeconds: 60,
    },
  });
  return { dataDir, db, sessions, messages, memcore, memoryService, ingestion };
}

function appendUserMessage(messages: MessageStore, sessionId: string, text: string): string {
  return messages.append({
    sessionId,
    role: "user",
    content: [{ type: "text", text }],
  }).id;
}

function appendAssistantMessage(messages: MessageStore, sessionId: string, text: string): string {
  return messages.append({
    sessionId,
    role: "assistant",
    content: [{ type: "text", text }],
  }).id;
}

describe("SessionIngestionService", () => {
  let fx: Fixtures;

  beforeEach(() => {
    fx = setup();
  });

  afterEach(async () => {
    await fx.ingestion.stop();
    fx.db.close();
    rmSync(fx.dataDir, { recursive: true, force: true });
  });

  it("ingests the full transcript on first run and advances the watermark", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    appendUserMessage(fx.messages, session.id, "hello");
    appendAssistantMessage(fx.messages, session.id, "world");
    const lastId = appendUserMessage(fx.messages, session.id, "again");

    const outcome = await fx.ingestion.ingestNow(session.id);

    expect(outcome).toEqual({ status: "ingested", chunkIndex: 1 });
    expect(fx.memcore.calls).toHaveLength(1);
    const [call] = fx.memcore.calls;
    expect(call?.args.extract).toBe(true);
    expect(call?.args.containerTag).toBe("test");
    expect(call?.args.content).toContain("User: hello");
    expect(call?.args.content).toContain("Assistant: world");
    expect(call?.args.content).toContain("User: again");
    expect(call?.args.metadata?.provenanceSessionId).toBe(session.id);
    expect(call?.args.metadata?.ingestChunkIndex).toBe(1);
    expect(call?.args.metadata?.lastMessageId).toBe(lastId);

    const state = fx.sessions.getIngestState(session.id);
    expect(state.watermarkMessageId).toBe(lastId);
    expect(state.status).toBe("idle");
    expect(state.chunksProcessed).toBe(1);
  });

  it("only ingests messages added since the watermark on resume", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    appendUserMessage(fx.messages, session.id, "first");
    appendAssistantMessage(fx.messages, session.id, "reply-one");

    await fx.ingestion.ingestNow(session.id);
    expect(fx.memcore.calls).toHaveLength(1);

    // User comes back; new turn lands.
    const newId = appendUserMessage(fx.messages, session.id, "follow-up");
    appendAssistantMessage(fx.messages, session.id, "reply-two");

    await fx.ingestion.ingestNow(session.id);

    expect(fx.memcore.calls).toHaveLength(2);
    const second = fx.memcore.calls[1]!.args;
    expect(second.content).not.toContain("User: first");
    expect(second.content).toContain("User: follow-up");
    expect(second.content).toContain("Assistant: reply-two");
    expect(second.metadata?.ingestChunkIndex).toBe(2);
    expect(second.metadata?.firstMessageId).toBe(newId);
  });

  it("skips when there is no unprocessed delta", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    appendUserMessage(fx.messages, session.id, "hi");
    await fx.ingestion.ingestNow(session.id);
    fx.memcore.calls.length = 0;

    const outcome = await fx.ingestion.ingestNow(session.id);

    expect(outcome).toEqual({ status: "skipped", reason: "no_delta" });
    expect(fx.memcore.calls).toHaveLength(0);
  });

  it("respects the min-delta gates during sweeper-triggered runs", async () => {
    const ingestion = new SessionIngestionService({
      memcore: fx.memcore as unknown as MemCore,
      sessions: fx.sessions,
      messages: fx.messages,
      memoryService: fx.memoryService,
      logger,
      containerTag: "test",
      config: {
        idleThresholdSeconds: 0,
        maxIdleSeconds: 60_000,
        minDeltaMessages: 5,
        minDeltaTokens: 1_000_000, // huge so the message gate is the only escape
        includeSubagents: false,
        sweeperIntervalSeconds: 60,
      },
    });

    const session = fx.sessions.create({ model: "test-model" });
    appendUserMessage(fx.messages, session.id, "small");
    appendAssistantMessage(fx.messages, session.id, "delta");

    await ingestion.tick();

    expect(fx.memcore.calls).toHaveLength(0);
    const state = fx.sessions.getIngestState(session.id);
    expect(state.watermarkMessageId).toBeNull();

    // ingestNow bypasses the min-delta check (manual override).
    const outcome = await ingestion.ingestNow(session.id);
    expect(outcome.status).toBe("ingested");
  });

  it("skips sessions marked as not-ingestable", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    fx.sessions.setIngestable(session.id, false);
    appendUserMessage(fx.messages, session.id, "hi");

    const outcome = await fx.ingestion.ingestNow(session.id);

    expect(outcome).toEqual({ status: "skipped", reason: "not_ingestable" });
    expect(fx.memcore.calls).toHaveLength(0);
  });

  it("invalidates the eager memory cache on success", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    appendUserMessage(fx.messages, session.id, "hello");

    // Prime the eager cache so we can confirm invalidation.
    const spy = vi.spyOn(fx.memoryService, "invalidateSession");
    await fx.ingestion.ingestNow(session.id);

    expect(spy).toHaveBeenCalledWith(session.id);
  });

  it("retains idle status with bumped attempts on transient failure", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    appendUserMessage(fx.messages, session.id, "broken");
    fx.memcore.failNext = 1;

    const outcome = await fx.ingestion.ingestNow(session.id);

    expect(outcome).toEqual({ status: "failed", attempts: 1, terminal: false });
    const state = fx.sessions.getIngestState(session.id);
    expect(state.status).toBe("idle");
    expect(state.attempts).toBe(1);
    expect(state.lastError).toContain("simulated extraction failure");
    expect(state.watermarkMessageId).toBeNull();
  });

  it("recovers in-flight jobs on boot via resetInFlightIngest", () => {
    const session = fx.sessions.create({ model: "test-model" });
    fx.sessions.setIngestStatus(session.id, "in_progress");

    const reset = fx.sessions.resetInFlightIngest();

    expect(reset).toBe(1);
    expect(fx.sessions.getIngestState(session.id).status).toBe("idle");
  });

  it("excludes assistant tool_use payloads from the transcript body but keeps a marker", async () => {
    const session = fx.sessions.create({ model: "test-model" });
    fx.messages.append({
      sessionId: session.id,
      role: "assistant",
      content: [
        { type: "text", text: "calling search" },
        { type: "tool_use", id: "t1", name: "code_search", input: { q: "foo" } },
      ],
    });
    fx.messages.append({
      sessionId: session.id,
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: "MASSIVE_FILE_DUMP".repeat(10),
        },
      ],
    });
    appendAssistantMessage(fx.messages, session.id, "found it");

    await fx.ingestion.ingestNow(session.id);

    const transcript = fx.memcore.calls[0]!.args.content!;
    expect(transcript).toContain("calling search");
    expect(transcript).toContain("[tool: code_search]");
    expect(transcript).toContain("found it");
    expect(transcript).not.toContain("MASSIVE_FILE_DUMP");
  });
});
