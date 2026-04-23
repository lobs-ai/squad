import { describe, it, expect } from "vitest";
import { AskUserTool, registerAskUserTool } from "./tools.js";
import { ToolRegistry } from "../registry.js";
import type { QuestionBackend, AskInput, AskResult } from "./backend.js";

const sampleQuestion: AskInput["questions"][number] = {
  header: "Pick",
  question: "a or b?",
  options: [
    { label: "a", description: "first" },
    { label: "b", description: "second" },
  ],
};

function backendReturning(result: AskResult): QuestionBackend & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async ask(input) {
      calls.push(input);
      return result;
    },
  };
}

describe("AskUserTool", () => {
  it("requires sessionId in ctx.meta", async () => {
    const tool = new AskUserTool(backendReturning({ status: "answered", answers: {} }));
    await expect(tool.run({ questions: [sampleQuestion] }, { cwd: "/tmp" })).rejects.toThrow(
      /sessionId/,
    );
  });

  it("defaults allowCustom to true and threads toolUseId through to backend", async () => {
    const backend = backendReturning({ status: "answered", answers: { q1: "a" } });
    const tool = new AskUserTool(backend);
    await tool.run(
      { questions: [sampleQuestion] },
      { cwd: "/tmp", meta: { sessionId: "s1", toolUseId: "call-42" } },
    );
    expect(backend.calls).toHaveLength(1);
    const call = backend.calls[0] as { sessionId: string; askedBy: string; input: AskInput };
    expect(call.sessionId).toBe("s1");
    expect(call.askedBy).toBe("call-42");
    expect(call.input.allowCustom).toBe(true);
    expect(call.input.timeoutSeconds).toBeUndefined();
  });

  it("forwards timeoutSeconds + allowCustom overrides verbatim", async () => {
    const backend = backendReturning({ status: "timed_out" });
    const tool = new AskUserTool(backend);
    await tool.run(
      { questions: [sampleQuestion], timeoutSeconds: 5, allowCustom: false },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    const call = backend.calls[0] as { input: AskInput };
    expect(call.input.timeoutSeconds).toBe(5);
    expect(call.input.allowCustom).toBe(false);
  });

  it("serialises the answer payload and defaults answers to {} when absent", async () => {
    const tool = new AskUserTool(backendReturning({ status: "cancelled" }));
    const result = await tool.run(
      { questions: [sampleQuestion] },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    expect(result).toMatchObject({ result: expect.any(String) });
    const parsed = JSON.parse((result as { result: string }).result);
    expect(parsed).toEqual({ status: "cancelled", answers: {} });
  });

  it("includes annotations when the backend returns them", async () => {
    const tool = new AskUserTool(
      backendReturning({
        status: "answered",
        answers: { q1: "a" },
        annotations: { q1: { notes: "n" } },
      }),
    );
    const result = await tool.run(
      { questions: [sampleQuestion] },
      { cwd: "/tmp", meta: { sessionId: "s1" } },
    );
    const parsed = JSON.parse((result as { result: string }).result);
    expect(parsed.annotations).toEqual({ q1: { notes: "n" } });
  });

  it("registerAskUserTool plugs into a ToolRegistry", () => {
    const reg = new ToolRegistry();
    registerAskUserTool(reg, backendReturning({ status: "answered", answers: {} }));
    expect(reg.has("ask_user")).toBe(true);
  });
});
