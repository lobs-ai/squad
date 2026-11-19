import { describe, it, expect } from "vitest";
import { CodexNormalizer, type CdxEvent } from "./normalize.js";
import { validateEventStream } from "../conformance.js";
import type { HarnessEvent } from "../types.js";

function run(evs: CdxEvent[]): { events: HarnessEvent[]; threadId: string | undefined } {
  const n = new CodexNormalizer();
  const events: HarnessEvent[] = [];
  for (const e of evs) events.push(...n.next(e));
  return { events, threadId: n.harnessSessionId() };
}

function accText(events: HarnessEvent[]): string {
  return events.filter((e) => e.t === "text.delta").map((e) => (e as { text: string }).text).join("");
}

describe("CodexNormalizer", () => {
  it("lifecycle: thread.started → session.init, agent_message streams, command runs", () => {
    const { events, threadId } = run([
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "a1", type: "agent_message", text: "Hel" } },
      { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Hello" } },
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "file.txt", exit_code: 0, status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 1, reasoning_output_tokens: 0 } },
    ]);

    expect(threadId).toBe("th-1");
    expect(events[0]).toEqual({ t: "session.init", harnessSessionId: "th-1", model: "", tools: [] });
    expect(events[1]).toEqual({ t: "turn.start" });
    expect(accText(events)).toBe("Hello");
    expect(events.find((e) => e.t === "tool.start")).toEqual({ t: "tool.start", id: "c1", name: "exec", input: { command: "ls" } });
    expect(events.find((e) => e.t === "tool.end")).toEqual({ t: "tool.end", id: "c1", output: "file.txt", isError: false });
    const end = events.at(-1);
    expect(end).toMatchObject({ t: "turn.end", stopReason: "end_turn" });
    expect((end as { usage: { cacheReadTokens?: number } }).usage.cacheReadTokens).toBe(1);
    expect(validateEventStream(events)).toEqual([]);
  });

  it("mcp_tool_call (completed only) synthesizes a paired tool.start/end with the squad tool name", () => {
    const { events } = run([
      { type: "thread.started", thread_id: "th-2" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "m1",
          type: "mcp_tool_call",
          server: "squad",
          tool: "create_task",
          arguments: { title: "x" },
          result: { content: [{ type: "text", text: "ok" }] },
          status: "completed",
        },
      },
      { type: "turn.completed", usage: {} },
    ]);
    expect(events.find((e) => e.t === "tool.start")).toEqual({ t: "tool.start", id: "m1", name: "create_task", input: { title: "x" } });
    expect(events.find((e) => e.t === "tool.end")).toEqual({ t: "tool.end", id: "m1", output: "ok", isError: false });
    expect(validateEventStream(events)).toEqual([]);
  });

  it("reasoning → thinking.delta; turn.failed → error + terminal turn.end", () => {
    const { events } = run([
      { type: "thread.started", thread_id: "th-3" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking…" } },
      { type: "turn.failed", error: { message: "boom" } },
    ]);
    expect(events.find((e) => e.t === "thinking.delta")).toEqual({ t: "thinking.delta", text: "thinking…" });
    expect(events.find((e) => e.t === "error")).toMatchObject({ t: "error", message: "boom" });
    expect(events.at(-1)).toMatchObject({ t: "turn.end", stopReason: "error" });
  });
});
