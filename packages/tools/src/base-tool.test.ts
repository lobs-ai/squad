import { describe, it, expect } from "vitest";
import { BaseTool, type ToolContext } from "./base-tool.js";
import type { ToolExecutorResult } from "./types.js";

class TaggedTool extends BaseTool<{ name: string }> {
  readonly name = "hello";
  readonly description = "greet";
  readonly inputSchema = {
    type: "object" as const,
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  readonly tags = ["readonly"] as const;
  async run(input: { name: string }, ctx: ToolContext): Promise<ToolExecutorResult> {
    const token = ctx.secrets?.["API_TOKEN"] ?? "none";
    return `hello ${input.name}:${token}:${ctx.cwd}`;
  }
}

class UntaggedTool extends BaseTool {
  readonly name = "nude";
  readonly description = "no tags";
  readonly inputSchema = { type: "object" as const };
  async run(): Promise<ToolExecutorResult> {
    return "ok";
  }
}

describe("BaseTool", () => {
  it("derives definition from fields and omits tags when absent", () => {
    const def = new UntaggedTool().definition;
    expect(def.name).toBe("nude");
    expect(def.description).toBe("no tags");
    expect(def.input_schema.type).toBe("object");
    expect(def.tags).toBeUndefined();
  });

  it("includes tags in the definition when set", () => {
    const def = new TaggedTool().definition;
    expect(def.tags).toEqual(["readonly"]);
  });

  it("toEntry wires cwd and meta into run()", async () => {
    const entry = new TaggedTool().toEntry();
    const result = await entry.executor({ name: "world" }, "/work", {});
    expect(result).toBe("hello world:none:/work");
  });

  it("toEntry routes meta.secrets into ToolContext.secrets", async () => {
    const entry = new TaggedTool().toEntry();
    const result = await entry.executor({ name: "alice" }, "/work", {
      secrets: { API_TOKEN: "xyz" },
    });
    expect(result).toBe("hello alice:xyz:/work");
  });
});
