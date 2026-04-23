import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import { BaseTool, type ToolContext } from "./base-tool.js";
import type { ToolExecutorResult, ToolEntry } from "./types.js";

class EchoTool extends BaseTool<{ value: string }> {
  readonly name = "echo";
  readonly description = "echoes a string";
  readonly inputSchema = {
    type: "object" as const,
    properties: { value: { type: "string" } },
    required: ["value"],
  };
  readonly tags = ["readonly", "text"] as const;
  async run(input: { value: string }, ctx: ToolContext): Promise<ToolExecutorResult> {
    return `${input.value}@${ctx.cwd}`;
  }
}

class WriteTool extends BaseTool<{ path: string }> {
  readonly name = "write";
  readonly description = "writes a path";
  readonly inputSchema = { type: "object" as const, properties: { path: { type: "string" } } };
  readonly tags = ["write", "filesystem"] as const;
  async run(input: { path: string }): Promise<ToolExecutorResult> {
    return `wrote ${input.path}`;
  }
}

const rawEntry: ToolEntry = {
  definition: { name: "raw", description: "raw entry", input_schema: { type: "object" } },
  executor: async () => "raw ok",
};

describe("ToolRegistry", () => {
  it("registers BaseTool instances and raw entries", () => {
    const reg = new ToolRegistry();
    reg.register(new EchoTool()).register(rawEntry);
    expect(reg.size).toBe(2);
    expect(reg.has("echo")).toBe(true);
    expect(reg.has("raw")).toBe(true);
    expect(reg.names().sort()).toEqual(["echo", "raw"]);
  });

  it("registerAll is chainable and adds in order", () => {
    const reg = new ToolRegistry().registerAll([new EchoTool(), new WriteTool()]);
    expect(reg.names()).toEqual(["echo", "write"]);
  });

  it("getDefinitions returns all when called without args", () => {
    const reg = new ToolRegistry().register(new EchoTool()).register(new WriteTool());
    const defs = reg.getDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(["echo", "write"]);
  });

  it("getDefinitions returns only requested names, skipping unknowns", () => {
    const reg = new ToolRegistry().register(new EchoTool()).register(new WriteTool());
    const defs = reg.getDefinitions(["echo", "does-not-exist"]);
    expect(defs.map((d) => d.name)).toEqual(["echo"]);
  });

  it("get returns definition or undefined", () => {
    const reg = new ToolRegistry().register(new EchoTool());
    expect(reg.get("echo")?.name).toBe("echo");
    expect(reg.get("missing")).toBeUndefined();
  });

  it("execute resolves for registered tools and plumbs cwd + meta", async () => {
    const reg = new ToolRegistry().register(new EchoTool());
    const result = await reg.execute("echo", { value: "hi" }, "/tmp");
    expect(result).toBe("hi@/tmp");
  });

  it("execute rejects for unregistered tools", async () => {
    const reg = new ToolRegistry();
    await expect(reg.execute("nope", {}, "/tmp")).rejects.toThrow(/Unknown tool/);
  });

  it("tagged returns tools that match any tag", () => {
    const reg = new ToolRegistry().register(new EchoTool()).register(new WriteTool());
    expect(reg.tagged("readonly").sort()).toEqual(["echo"]);
    expect(reg.tagged("write").sort()).toEqual(["write"]);
    expect(reg.tagged("readonly", "write").sort()).toEqual(["echo", "write"]);
    expect(reg.tagged("nope")).toEqual([]);
  });

  it("filter returns names whose definitions satisfy the predicate", () => {
    const reg = new ToolRegistry().register(new EchoTool()).register(new WriteTool());
    const out = reg.filter((d) => d.tags?.includes("filesystem") ?? false);
    expect(out).toEqual(["write"]);
  });

  it("re-registering the same name replaces the entry", () => {
    const reg = new ToolRegistry().register(new EchoTool());
    const replacement: ToolEntry = {
      definition: { name: "echo", description: "replaced", input_schema: { type: "object" } },
      executor: async () => "new",
    };
    reg.register(replacement);
    expect(reg.size).toBe(1);
    expect(reg.get("echo")?.description).toBe("replaced");
  });
});
