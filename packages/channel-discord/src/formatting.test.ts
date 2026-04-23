import { describe, it, expect } from "vitest";
import { chunkMessage } from "./formatting.js";

describe("chunkMessage", () => {
  it("passes short messages through untouched", () => {
    expect(chunkMessage("hello", 1900)).toEqual(["hello"]);
  });

  it("breaks on newlines when possible", () => {
    const input = "a".repeat(1800) + "\n" + "b".repeat(200);
    const out = chunkMessage(input, 1900);
    expect(out).toHaveLength(2);
    expect(out[0]!.endsWith("a")).toBe(true);
    expect(out[1]!.startsWith("b")).toBe(true);
  });

  it("falls back to hard cut when no break point exists", () => {
    const out = chunkMessage("x".repeat(2500), 1000);
    expect(out.every((c) => c.length <= 1000)).toBe(true);
    expect(out.join("")).toBe("x".repeat(2500));
  });
});
