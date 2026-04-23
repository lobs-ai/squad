import { describe, it, expect } from "vitest";
import { methodRegistry, eventRegistry, parseMethodParams, parseEventData } from "./index.js";

describe("method registry", () => {
  it("covers every namespace mentioned in SPEC §Wire Protocol", () => {
    const names = Object.keys(methodRegistry);
    for (const m of [
      "session.start",
      "session.resume",
      "session.end",
      "session.list",
      "session.search",
      "chat.send",
      "chat.history",
      "subagents.list",
      "subagents.spawn",
      "subagents.cancel",
      "subagents.tree",
      "subagents.history",
      "tasks.create",
      "tasks.update",
      "tasks.get",
      "tasks.list",
      "tasks.delete",
      "tasks.claim",
      "tasks.watch",
      "questions.ask",
      "questions.answer",
      "questions.cancel",
      "questions.list",
      "questions.history",
      "approvals.list",
      "approvals.decide",
      "plugins.list",
      "plugins.enable",
      "plugins.disable",
      "plugins.reload",
      "plugins.configure",
      "channels.list",
      "channels.bind",
      "channels.unbind",
      "channels.capabilities",
      "routines.list",
      "routines.create",
      "routines.update",
      "routines.delete",
      "routines.run_now",
      "admin.health",
      "admin.config",
      "admin.tokens.create",
      "admin.tokens.revoke",
    ]) {
      expect(names).toContain(m);
    }
  });

  it("parses valid chat.send params", () => {
    const params = parseMethodParams("chat.send", {
      sessionId: "s1",
      content: "hello",
    });
    expect(params.sessionId).toBe("s1");
  });

  it("rejects chat.send with missing sessionId", () => {
    expect(() =>
      parseMethodParams("chat.send", { content: "hello" }),
    ).toThrow();
  });
});

describe("event registry", () => {
  it("covers every event mentioned in SPEC §Wire Protocol", () => {
    const names = Object.keys(eventRegistry);
    for (const e of [
      "chat.user_message",
      "chat.assistant_message",
      "chat.text_delta",
      "chat.tool_call",
      "chat.tool_result",
      "subagents.spawned",
      "subagents.text_delta",
      "subagents.tool_call",
      "subagents.tool_result",
      "subagents.completed",
      "subagents.failed",
      "tasks.created",
      "tasks.updated",
      "tasks.deleted",
      "questions.asked",
      "questions.answered",
      "questions.cancelled",
      "questions.timed_out",
      "approvals.pending",
      "approvals.decided",
      "plugins.changed",
      "routines.fired",
      "log.line",
    ]) {
      expect(names).toContain(e);
    }
  });

  it("parses a valid tasks.created event payload", () => {
    parseEventData("tasks.created", {
      task: {
        id: "t1",
        taskListId: "s1",
        subject: "do it",
        description: "the thing",
        owner: null,
        status: "pending",
        blocks: [],
        blockedBy: [],
        createdAt: "2026-04-23T00:00:00Z",
        updatedAt: "2026-04-23T00:00:00Z",
      },
    });
  });
});
