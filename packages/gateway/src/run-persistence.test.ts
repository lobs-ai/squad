import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "@squad/runner";
import { openDb, type DatabaseHandle } from "./db/index.js";
import { SessionStore } from "./db/sessions.js";
import { MessageStore } from "./db/messages.js";
import { Broadcast } from "./broadcast.js";
import { RunPersister } from "./run-persistence.js";

let dataDir: string;
let db: DatabaseHandle;
let sessions: SessionStore;
let messages: MessageStore;
let broadcast: Broadcast;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "squad-runp-"));
  db = openDb({ path: join(dataDir, "test.db") });
  sessions = new SessionStore(db);
  messages = new MessageStore(db);
  broadcast = new Broadcast();
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("RunPersister.flush", () => {
  it("persists assistant + tool messages incrementally and only newer slices", () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    const runnerSession = new Session([
      { role: "user", content: "hi" },
    ]);
    const persister = new RunPersister({
      messages,
      broadcast,
      sessionId: session.id,
      session: runnerSession,
      runId: "run-1",
      messageCountBefore: 1,
    });

    // Turn 1: assistant message with a tool_use, then a tool_result user message.
    runnerSession._ref().push({
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "use_1", name: "read_file", input: { path: "x" } },
      ],
    });
    runnerSession._ref().push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "use_1",
          content: "file contents",
          is_error: false,
        },
        { type: "text", text: "<reminder>" },
      ],
    });

    expect(persister.flush()).toBe(2);

    const after1 = messages.listForSession(session.id, 100);
    expect(after1.map((m) => m.role)).toEqual(["assistant", "tool"]);
    const assistantContent = after1[0]!.content;
    expect(assistantContent.some((b) => b.type === "tool_use")).toBe(true);
    const toolContent = after1[1]!.content;
    expect(toolContent[0]!.type).toBe("tool_result");

    // Calling flush again with no new messages writes nothing.
    expect(persister.flush()).toBe(0);
    expect(messages.countForSession(session.id)).toBe(2);

    // Turn 2: another assistant message ends the run with no tool calls.
    runnerSession._ref().push({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });

    expect(persister.flush()).toBe(1);
    expect(messages.countForSession(session.id)).toBe(3);
  });

  it("finalize broadcasts chat.assistant_message exactly once", async () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    const runnerSession = new Session([{ role: "user", content: "hi" }]);
    const persister = new RunPersister({
      messages,
      broadcast,
      sessionId: session.id,
      session: runnerSession,
      runId: "run-x",
      messageCountBefore: 1,
    });

    runnerSession._ref().push({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });

    const seen: unknown[] = [];
    broadcast.subscribe(
      { id: "test", send: (frame) => seen.push(frame) },
      `chat.assistant_message/${session.id}`,
    );

    persister.finalize("fallback");
    expect(seen).toHaveLength(1);

    // Subsequent flushes do nothing once finalized.
    runnerSession._ref().push({
      role: "assistant",
      content: [{ type: "text", text: "ignored" }],
    });
    expect(persister.flush()).toBe(0);
  });

  it("finalize falls back to provided text when the runner produced no assistant message", () => {
    const session = sessions.create({ model: "claude-sonnet-4-6" });
    const runnerSession = new Session([{ role: "user", content: "hi" }]);
    const persister = new RunPersister({
      messages,
      broadcast,
      sessionId: session.id,
      session: runnerSession,
      runId: "run-empty",
      messageCountBefore: 1,
    });

    persister.finalize("safety net");
    const all = messages.listForSession(session.id, 100);
    expect(all.map((m) => m.role)).toEqual(["assistant"]);
    expect(all[0]!.content).toEqual([{ type: "text", text: "safety net" }]);
  });
});
