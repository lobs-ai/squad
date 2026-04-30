import { describe, it, expect } from "vitest";
import { ToolRegistry, BaseTool } from "@squad/tools";
import {
  ToolsetRegistry,
  ToolsetUnknownError,
  ToolsetMissingToolError,
} from "./registry.js";

class FakeTool extends BaseTool<Record<string, unknown>> {
  readonly inputSchema = { type: "object" as const, properties: {} };
  readonly description = "fake";
  constructor(public readonly name: string) {
    super();
  }
  async run(): Promise<{ result: string }> {
    return { result: "ok" };
  }
}

function regOf(...names: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const n of names) reg.register(new FakeTool(n) as unknown as BaseTool<Record<string, unknown>>);
  return reg;
}

describe("ToolsetRegistry", () => {
  it("resolves a registered toolset to its declared tools", () => {
    const ts = new ToolsetRegistry(regOf("read_file", "list_tasks"));
    ts.register({
      name: "@squad/toolset-research",
      description: "read-only research",
      tools: ["read_file", "list_tasks"],
    });
    expect(ts.resolve("@squad/toolset-research")).toEqual(["read_file", "list_tasks"]);
  });

  it("throws ToolsetUnknownError for an unknown toolset name", () => {
    const ts = new ToolsetRegistry(regOf("read_file"));
    expect(() => ts.resolve("@squad/missing")).toThrow(ToolsetUnknownError);
  });

  it("throws ToolsetMissingToolError when a tool isn't registered", () => {
    const ts = new ToolsetRegistry(regOf("read_file"));
    ts.register({
      name: "broken",
      description: "...",
      tools: ["read_file", "ghost_tool"],
    });
    expect(() => ts.resolve("broken")).toThrow(ToolsetMissingToolError);
  });

  it("resolveMany unions explicit tools and toolset members, deduping", () => {
    const ts = new ToolsetRegistry(regOf("read_file", "list_tasks", "create_task"));
    ts.register({
      name: "research",
      description: "...",
      tools: ["read_file", "list_tasks"],
    });
    ts.register({
      name: "writer",
      description: "...",
      tools: ["create_task", "read_file"],
    });
    expect(ts.resolveMany(["research", "writer"], ["list_tasks"])).toEqual([
      "list_tasks",
      "read_file",
      "create_task",
    ]);
  });

  it("rejects empty / nameless toolsets at register time", () => {
    const ts = new ToolsetRegistry(regOf("read_file"));
    expect(() => ts.register({ name: "", description: "", tools: ["read_file"] })).toThrow();
    expect(() => ts.register({ name: "x", description: "", tools: [] })).toThrow();
  });
});
