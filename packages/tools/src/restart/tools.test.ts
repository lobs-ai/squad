import { describe, it, expect } from "vitest";
import { RestartGatewayTool, registerRestartTool } from "./tools.js";
import type { RestartBackend } from "./backend.js";
import { ToolRegistry } from "../registry.js";

function fakeBackend(): RestartBackend & {
  calls: Array<{ reason: string }>;
  shouldThrow?: Error;
} {
  const calls: Array<{ reason: string }> = [];
  return {
    calls,
    async requestRestart(input) {
      if (this.shouldThrow) throw this.shouldThrow;
      calls.push({ reason: input.reason });
      return { scheduled: true, delayMs: 750, reason: input.reason };
    },
  };
}

describe("restart_gateway tool", () => {
  it("requests a restart through the backend with the supplied reason", async () => {
    const backend = fakeBackend();
    const tool = new RestartGatewayTool(backend);
    const res = await tool.run({ reason: "config edit" }, { cwd: "/" });
    const payload = JSON.parse(res.result as string);
    expect(backend.calls).toEqual([{ reason: "config edit" }]);
    expect(payload).toMatchObject({
      ok: true,
      scheduled: true,
      delayMs: 750,
      reason: "config edit",
    });
  });

  it("falls back to a default reason when none is given", async () => {
    const backend = fakeBackend();
    const tool = new RestartGatewayTool(backend);
    await tool.run({}, { cwd: "/" });
    expect(backend.calls[0]?.reason).toBe("agent-requested restart");
  });

  it("trims whitespace-only reasons to the default", async () => {
    const backend = fakeBackend();
    const tool = new RestartGatewayTool(backend);
    await tool.run({ reason: "   " }, { cwd: "/" });
    expect(backend.calls[0]?.reason).toBe("agent-requested restart");
  });

  it("propagates backend errors so the agent learns the restart didn't schedule", async () => {
    const backend = fakeBackend();
    backend.shouldThrow = new Error("no respawn guarantee detected");
    const tool = new RestartGatewayTool(backend);
    await expect(tool.run({}, { cwd: "/" })).rejects.toThrow(/no respawn/);
  });

  it("is tagged restart + dangerous so approval policy can require user consent", () => {
    const tool = new RestartGatewayTool(fakeBackend());
    expect(tool.tags).toContain("restart");
    expect(tool.tags).toContain("dangerous");
  });

  it("registerRestartTool registers under the expected name", () => {
    const registry = new ToolRegistry();
    registerRestartTool(registry, fakeBackend());
    expect(registry.names()).toContain("restart_gateway");
  });
});
