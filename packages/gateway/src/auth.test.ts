import { describe, it, expect } from "vitest";
import { Authenticator } from "./auth.js";

describe("Authenticator.verify", () => {
  it("returns null when no token is provided", () => {
    const a = new Authenticator([{ label: "t", secret: "s", scopes: ["*"] }]);
    expect(a.verify(undefined)).toBeNull();
    expect(a.verify("")).toBeNull();
  });

  it("returns the matching grant on exact match", () => {
    const a = new Authenticator([{ label: "cli", secret: "abc", scopes: ["chat.*"] }]);
    expect(a.verify("abc")).toEqual({ label: "cli", scopes: ["chat.*"] });
  });

  it("returns null on mismatch or length mismatch", () => {
    const a = new Authenticator([{ label: "cli", secret: "abc", scopes: ["*"] }]);
    expect(a.verify("wrong")).toBeNull();
    expect(a.verify("abcd")).toBeNull();
  });

  it("supports multiple configured tokens", () => {
    const a = new Authenticator([
      { label: "a", secret: "one", scopes: ["*"] },
      { label: "b", secret: "two", scopes: ["chat.send"] },
    ]);
    expect(a.verify("one")?.label).toBe("a");
    expect(a.verify("two")?.label).toBe("b");
  });
});

describe("Authenticator.authorized", () => {
  const a = new Authenticator([]);

  it("wildcard grant covers every scope", () => {
    expect(a.authorized({ label: "x", scopes: ["*"] }, "chat.send")).toBe(true);
    expect(a.authorized({ label: "x", scopes: ["*"] }, "admin.restart")).toBe(true);
  });

  it("exact scope match", () => {
    expect(a.authorized({ label: "x", scopes: ["chat.send"] }, "chat.send")).toBe(true);
    expect(a.authorized({ label: "x", scopes: ["chat.send"] }, "chat.history")).toBe(false);
  });

  it("prefix .* matches any suffix under that namespace", () => {
    const g = { label: "x", scopes: ["chat.*"] };
    expect(a.authorized(g, "chat.send")).toBe(true);
    expect(a.authorized(g, "chat.history")).toBe(true);
    expect(a.authorized(g, "tasks.list")).toBe(false);
  });

  it("multiple scopes: any match grants", () => {
    const g = { label: "x", scopes: ["tasks.*", "chat.send"] };
    expect(a.authorized(g, "chat.send")).toBe(true);
    expect(a.authorized(g, "tasks.list")).toBe(true);
    expect(a.authorized(g, "chat.history")).toBe(false);
  });

  it("empty scopes grants nothing", () => {
    expect(a.authorized({ label: "x", scopes: [] }, "chat.send")).toBe(false);
  });
});
