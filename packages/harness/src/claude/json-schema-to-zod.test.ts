import { describe, it, expect } from "vitest";
import { z } from "zod";
import { jsonSchemaToZodShape, jsonSchemaToZodType } from "./json-schema-to-zod.js";

describe("jsonSchemaToZodShape", () => {
  it("models a typical squad tool schema (required + optional + enum + array)", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["title"],
    });
    const obj = z.object(shape);

    // required-only is valid; optionals may be omitted
    expect(obj.parse({ title: "x" })).toEqual({ title: "x" });
    // full payload round-trips
    expect(
      obj.parse({ title: "x", count: 3, tags: ["a", "b"], mode: "b" }),
    ).toEqual({ title: "x", count: 3, tags: ["a", "b"], mode: "b" });
  });

  it("enforces required fields and enum membership", () => {
    const obj = z.object(
      jsonSchemaToZodShape({
        type: "object",
        properties: { title: { type: "string" }, mode: { type: "string", enum: ["a", "b"] } },
        required: ["title"],
      }),
    );
    expect(() => obj.parse({ mode: "a" })).toThrow(); // missing required title
    expect(() => obj.parse({ title: "x", mode: "z" })).toThrow(); // bad enum value
  });

  it("returns an empty shape for no-arg tools", () => {
    expect(jsonSchemaToZodShape({ type: "object" })).toEqual({});
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
  });

  it("falls back to permissive z.any() for unmodellable nodes", () => {
    // No type, mixed-type enum → anything goes (executor validates).
    const t = jsonSchemaToZodType({ enum: [1, "two", true] });
    expect(t.parse(1)).toBe(1);
    expect(t.parse("anything")).toBe("anything");
  });

  it("handles nested objects and nullable fields", () => {
    const obj = z.object(
      jsonSchemaToZodShape({
        type: "object",
        properties: {
          opts: {
            type: "object",
            properties: { flag: { type: "boolean" } },
          },
          note: { type: "string", nullable: true },
        },
        required: ["opts"],
      }),
    );
    expect(obj.parse({ opts: { flag: true }, note: null })).toEqual({
      opts: { flag: true },
      note: null,
    });
  });
});
