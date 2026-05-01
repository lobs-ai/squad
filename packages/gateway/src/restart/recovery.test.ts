import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DatabaseHandle } from "../db/index.js";
import { SessionStore } from "../db/sessions.js";
import { MessageStore } from "../db/messages.js";
import { ToolCallStore } from "../db/tool-calls.js";
import { Broadcast } from "../broadcast.js";
import { logger } from "../logger.js";
import type { ContentBlock } from "@squad/protocol";
import { recoverInFlightRuns, repairTrailingToolUse } from "./recovery.js";
import type { RunCoordinator } from "../delivery/coordinator.js";

let dataDir: string;
let db: DatabaseHandle;
let sessions: SessionStore;
let messages: MessageStore;
let toolCalls: ToolCallStore;
let broadcast: Broadcast;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "squad-recovery-"));
  db = openDb({ path: join(dataDir, "test.db") });
  sessions = new SessionStore(db);
  messages = new MessageStore(db);
  toolCalls = new ToolCallStore(db);
  broadcast = new Broadcast();
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("repairTrailingToolUse", () => {
  it("appends a synthetic tool message when the last assistant has unanswered tool_use", () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    messages.append({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "do the thing" }],
    });
    messages.append({
      sessionId: session.id,
      role: "assistant",
      content: [
        { type: "text", text: "running tools" },
        { type: "tool_use", id: "use_1", name: "read_file", input: {} },
        { type: "tool_use", id: "use_2", name: "list_directory", input: {} },
      ],
    });

    const history = messages.listForSession(session.id, 100);
    const out = repairTrailingToolUse(session.id, history, messages);
    expect(out.repaired).toBe(true);
    expect(out.synthesizedToolResults).toBe(2);

    const after = messages.listForSession(session.id, 100);
    expect(after.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const toolBlocks = after[2]!.content as ContentBlock[];
    expect(toolBlocks).toHaveLength(2);
    for (const b of toolBlocks) {
      expect(b.type).toBe("tool_result");
      if (b.type === "tool_result") {
        expect(b.isError).toBe(true);
        expect(b.content).toMatch(/interrupted by gateway restart/i);
      }
    }
  });

  it("is a no-op when last message has no tool_use", () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    messages.append({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "all done" }],
    });
    const out = repairTrailingToolUse(
      session.id,
      messages.listForSession(session.id, 100),
      messages,
    );
    expect(out.repaired).toBe(false);
    expect(messages.countForSession(session.id)).toBe(1);
  });
});

interface FakeCoordinator {
  delivered: Array<{ sessionId: string; content: ContentBlock[] }>;
}

function makeCoordinator(): RunCoordinator {
  const stub: FakeCoordinator & { deliverExternalMessage: RunCoordinator["deliverExternalMessage"] } = {
    delivered: [],
    deliverExternalMessage: async (sessionId, content) => {
      stub.delivered.push({ sessionId, content });
    },
  };
  return stub as unknown as RunCoordinator;
}

describe("recoverInFlightRuns", () => {
  it("resets running sessions, repairs unmatched tool_use, marks orphan tool_calls failed, and re-fires a turn", async () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    sessions.setStatus(session.id, "running");
    messages.append({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "go" }],
    });
    messages.append({
      sessionId: session.id,
      role: "assistant",
      content: [
        { type: "tool_use", id: "use_1", name: "read_file", input: {} },
      ],
    });
    // Orphan pending tool_call row from the previous run.
    const orphan = toolCalls.begin({
      sessionId: session.id,
      runId: "old-run",
      name: "read_file",
      input: {},
    });
    expect(orphan.status).toBe("pending");

    const coordinator = makeCoordinator();
    const events: Array<{ topic: string; data: unknown }> = [];
    broadcast.subscribe(
      { id: "t", send: (f) => events.push({ topic: f.topic, data: f.data }) },
      `session.resumed/${session.id}`,
    );

    const result = await recoverInFlightRuns({
      sessions,
      messages,
      toolCalls,
      coordinator,
      broadcast,
      logger,
      db,
    });

    expect(result.candidates).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.orphanToolCalls).toBe(1);

    // Session reset to idle, message tail repaired.
    expect(sessions.get(session.id).status).toBe("idle");
    const post = messages.listForSession(session.id, 100);
    expect(post.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);

    // Orphan tool_call marked failed.
    expect(toolCalls.get(orphan.id).status).toBe("failed");

    // Coordinator received an external delivery (empty content) to re-fire the turn.
    const stub = coordinator as unknown as FakeCoordinator;
    expect(stub.delivered).toHaveLength(1);
    expect(stub.delivered[0]!.sessionId).toBe(session.id);
    expect(stub.delivered[0]!.content).toEqual([]);

    // Resume event published.
    expect(events.find((e) => e.topic === `session.resumed/${session.id}`)).toBeDefined();
  });

  it("does not re-fire a turn when the session's last message is a clean assistant end_turn", async () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    sessions.setStatus(session.id, "running");
    messages.append({
      sessionId: session.id,
      role: "user",
      content: [{ type: "text", text: "go" }],
    });
    messages.append({
      sessionId: session.id,
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });

    const coordinator = makeCoordinator();
    const result = await recoverInFlightRuns({
      sessions,
      messages,
      toolCalls,
      coordinator,
      broadcast,
      logger,
      db,
    });

    expect(result.candidates).toBe(1);
    expect(result.noResumeNeeded).toBe(1);
    expect(result.resumed).toBe(0);
    expect(sessions.get(session.id).status).toBe("idle");
    expect((coordinator as unknown as FakeCoordinator).delivered).toHaveLength(0);
  });

  it("skips subagent sessions (parent session id present)", async () => {
    const parent = sessions.create({ model: "claude-sonnet-4-6" });
    const subagent = sessions.create({
      model: "claude-sonnet-4-6",
      parentSessionId: parent.id,
    });
    sessions.setStatus(subagent.id, "running");
    messages.append({
      sessionId: subagent.id,
      role: "assistant",
      content: [{ type: "tool_use", id: "u_1", name: "read_file", input: {} }],
    });

    const coordinator = makeCoordinator();
    const result = await recoverInFlightRuns({
      sessions,
      messages,
      toolCalls,
      coordinator,
      broadcast,
      logger,
      db,
    });

    expect(result.candidates).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.resumed).toBe(0);
    expect(sessions.get(subagent.id).status).toBe("idle");
    expect((coordinator as unknown as FakeCoordinator).delivered).toHaveLength(0);
  });

  it("returns zeros and does no work when no sessions are running", async () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    expect(sessions.get(session.id).status).toBe("idle");

    const coordinator = makeCoordinator();
    const result = await recoverInFlightRuns({
      sessions,
      messages,
      toolCalls,
      coordinator,
      broadcast,
      logger,
      db,
    });

    expect(result).toEqual({
      candidates: 0,
      resumed: 0,
      noResumeNeeded: 0,
      skipped: 0,
      orphanToolCalls: 0,
    });
  });
});
