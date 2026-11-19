import { describe, it, expect } from "vitest";
import { ClaudeNormalizer, type RawSdkMessage } from "./normalize.js";
import { validateEventStream } from "../conformance.js";
import type { HarnessEvent } from "../types.js";

function run(msgs: RawSdkMessage[]): { events: HarnessEvent[]; hsid: string | undefined } {
  const norm = new ClaudeNormalizer();
  const events: HarnessEvent[] = [];
  for (const m of msgs) events.push(...norm.next(m));
  return { events, hsid: norm.harnessSessionId() };
}

const init: RawSdkMessage = {
  type: "system",
  subtype: "init",
  session_id: "sess-abc",
  model: "claude-sonnet-4-5",
  tools: ["Read", "Bash", { name: "mcp__squad__ask_user" }],
};

function accumulatedText(events: HarnessEvent[]): string {
  return events.filter((e) => e.t === "text.delta").map((e) => (e as { text: string }).text).join("");
}

describe("ClaudeNormalizer", () => {
  it("streaming: dedupes partials against the complete assistant message", () => {
    const { events, hsid } = run([
      init,
      { type: "partial_assistant", partial: { content: [{ type: "text", text: "He" }] } },
      { type: "partial_assistant", partial: { content: [{ type: "text", text: "Hello" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "result", subtype: "success", result: "Hello", usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.001 },
    ]);

    expect(hsid).toBe("sess-abc");
    expect(events[0]).toEqual({ t: "session.init", harnessSessionId: "sess-abc", model: "claude-sonnet-4-5", tools: ["Read", "Bash", "mcp__squad__ask_user"] });
    expect(events[1]).toEqual({ t: "turn.start" });
    // "He" then "llo" — and NOT a third "Hello" from the assistant/result.
    expect(accumulatedText(events)).toBe("Hello");
    const end = events.at(-1);
    expect(end).toMatchObject({ t: "turn.end", stopReason: "end_turn" });
    expect((end as { usage: { costUsd?: number } }).usage.costUsd).toBe(0.001);
    expect(validateEventStream(events)).toEqual([]);
  });

  it("non-streaming with a tool call: text + tool.start/tool.end + final text", () => {
    const { events } = run([
      init,
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Working" },
            { type: "tool_use", id: "tu1", name: "mcp__squad__create_task", input: { title: "x" } },
          ],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 5, output_tokens: 2 } },
    ]);

    const toolStart = events.find((e) => e.t === "tool.start");
    expect(toolStart).toEqual({ t: "tool.start", id: "tu1", name: "create_task", input: { title: "x" } });
    expect(events.find((e) => e.t === "tool.end")).toEqual({ t: "tool.end", id: "tu1", output: "ok", isError: false });
    // "Working" (seg 1) + "Done" (seg 2), no duplication from the result fallback.
    expect(accumulatedText(events)).toBe("WorkingDone");
    expect(validateEventStream(events)).toEqual([]);
  });

  it("result-only fallback emits the canonical text once", () => {
    const { events } = run([
      init,
      { type: "result", subtype: "success", result: "Answer", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(accumulatedText(events)).toBe("Answer");
    expect(validateEventStream(events)).toEqual([]);
  });

  it("maps error subtypes and surfaces thinking deltas", () => {
    const { events } = run([
      init,
      { type: "partial_assistant", partial: { content: [{ type: "thinking", thinking: "hmm" }] } },
      { type: "result", subtype: "error_max_turns", usage: {} },
    ]);
    expect(events.find((e) => e.t === "thinking.delta")).toEqual({ t: "thinking.delta", text: "hmm" });
    expect(events.at(-1)).toMatchObject({ t: "turn.end", stopReason: "max_turns" });
  });
});
