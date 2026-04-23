import { describe, it, expect } from "vitest";
import { matchesCron } from "./scheduler.js";

function at(hour: number, minute: number, day = 1, month = 1, dow = 0): Date {
  const d = new Date(2026, month - 1, day, hour, minute, 0, 0);
  // dow param is indicative — Date derives it from the actual date.
  void dow;
  return d;
}

describe("matchesCron", () => {
  it("matches wildcards", () => {
    expect(matchesCron("* * * * *", at(9, 0))).toBe(true);
  });

  it("matches an explicit hour + minute", () => {
    expect(matchesCron("15 9 * * *", at(9, 15))).toBe(true);
    expect(matchesCron("15 9 * * *", at(9, 16))).toBe(false);
    expect(matchesCron("15 9 * * *", at(10, 15))).toBe(false);
  });

  it("matches a step expression", () => {
    expect(matchesCron("*/5 * * * *", at(9, 0))).toBe(true);
    expect(matchesCron("*/5 * * * *", at(9, 10))).toBe(true);
    expect(matchesCron("*/5 * * * *", at(9, 12))).toBe(false);
  });

  it("matches a comma list", () => {
    expect(matchesCron("0,30 * * * *", at(9, 30))).toBe(true);
    expect(matchesCron("0,30 * * * *", at(9, 15))).toBe(false);
  });

  it("rejects bad input shapes", () => {
    expect(matchesCron("wrong", at(9, 0))).toBe(false);
  });
});
