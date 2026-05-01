import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import { McpRegistry } from "./registry.js";

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
} as unknown as Parameters<typeof McpRegistry>[0]["logger"];

/** Build a tiny Node script that speaks MCP over stdio with one tool. */
function fakeServerScript(): string {
  return `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "0.0.0" },
    } });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [
      {
        name: "echo",
        description: "echoes its input",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
      {
        name: "noisy",
        description: "noisy",
        inputSchema: { type: "object", properties: {} },
      },
    ] } });
  }
  if (method === "tools/call") {
    const args = params.arguments || {};
    if (params.name === "echo") {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo: " + (args.text || "") }] } });
    }
    return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
  }
  if (method === "notifications/initialized") return;
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
});
`;
}

describe("McpRegistry", () => {
  let dir: string;
  let scriptPath: string;
  let toolRegistry: ToolRegistry;
  let registry: McpRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "squad-mcp-"));
    scriptPath = join(dir, "fake-server.js");
    writeFileSync(scriptPath, fakeServerScript());
    chmodSync(scriptPath, 0o755);
    toolRegistry = new ToolRegistry();
    registry = new McpRegistry({ toolRegistry, logger: stubLogger });
  });

  afterEach(async () => {
    await registry.stopAll();
  });

  it("imports server tools into the ToolRegistry", async () => {
    await registry.load({
      id: "fake",
      command: process.execPath,
      args: [scriptPath],
    });
    const names = toolRegistry.names();
    expect(names).toContain("mcp__fake__echo");
    expect(names).toContain("mcp__fake__noisy");
  });

  it("invokes a tool over the stdio transport", async () => {
    await registry.load({
      id: "fake",
      command: process.execPath,
      args: [scriptPath],
    });
    const result = await toolRegistry.execute(
      "mcp__fake__echo",
      { text: "hello" },
      "/tmp",
    );
    expect(result).toBe("echo: hello");
  });

  it("respects allow / deny lists", async () => {
    await registry.load({
      id: "fake",
      command: process.execPath,
      args: [scriptPath],
      allow: ["echo"],
    });
    expect(toolRegistry.names()).toContain("mcp__fake__echo");
    expect(toolRegistry.names()).not.toContain("mcp__fake__noisy");
  });

  it("propagates tool errors as exceptions", async () => {
    await registry.load({
      id: "fake",
      command: process.execPath,
      args: [scriptPath],
    });
    await expect(
      toolRegistry.execute("mcp__fake__noisy", {}, "/tmp"),
    ).rejects.toThrow(/boom/);
  });
});
