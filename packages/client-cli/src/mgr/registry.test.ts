import { describe, expect, it } from "vitest";
import { findFreePort, validateName, type Registry } from "./registry.js";

const REG: Registry = {
  build_context: "/tmp/x",
  squads: [
    { name: "alpha", port: 8081 },
    { name: "beta", port: 8082 },
  ],
  shared: { searxng_port: 8888 },
};

describe("findFreePort", () => {
  it("returns the first port not claimed by a squad", () => {
    expect(findFreePort(REG, 8080)).toBe(8080);
  });

  it("skips taken ports", () => {
    expect(findFreePort({ ...REG, squads: [...REG.squads, { name: "g", port: 8080 }] })).toBe(8083);
  });

  it("avoids the searxng port too", () => {
    expect(findFreePort({ ...REG, squads: [], shared: { searxng_port: 8080 } }, 8080)).toBe(8081);
  });
});

describe("validateName", () => {
  it("accepts kebab + snake + alnum", () => {
    expect(() => validateName("alpha")).not.toThrow();
    expect(() => validateName("a")).not.toThrow();
    expect(() => validateName("squad-1")).not.toThrow();
    expect(() => validateName("squad_1")).not.toThrow();
    expect(() => validateName("ab12_x-y")).not.toThrow();
  });

  it("rejects uppercase, leading dash, and overlong names", () => {
    expect(() => validateName("Alpha")).toThrow();
    expect(() => validateName("-x")).toThrow();
    expect(() => validateName("")).toThrow();
    expect(() => validateName("a".repeat(40))).toThrow();
    expect(() => validateName("foo bar")).toThrow();
  });

  it("rejects names that collide with top-level ~/.squad/ files", () => {
    for (const reserved of ["current", "env", "shared", "extensions", "squads"]) {
      expect(() => validateName(reserved), `'${reserved}' should be reserved`).toThrow(/reserved/);
    }
  });
});
