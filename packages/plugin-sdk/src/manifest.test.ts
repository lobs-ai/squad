import { describe, it, expect } from "vitest";
import { parsePluginManifest, satisfiesRequires } from "./manifest.js";

describe("parsePluginManifest", () => {
  it("accepts the minimal shape", () => {
    const m = parsePluginManifest({
      id: "@squad/foo",
      name: "Foo",
      version: "1.0.0",
      entry: "index.js",
    });
    expect(m.id).toBe("@squad/foo");
    expect(m.exposes).toEqual([]);
    expect(m.requires).toEqual([]);
  });

  it("rejects missing required fields", () => {
    expect(() => parsePluginManifest({ id: "x" })).toThrow();
  });

  it("validates permission strings", () => {
    expect(() =>
      parsePluginManifest({
        id: "@squad/foo",
        name: "Foo",
        version: "1.0.0",
        entry: "index.js",
        permissions: ["tools", "weeeird"],
      }),
    ).toThrow();
  });
});

describe("satisfiesRequires", () => {
  it("matches bare ids", () => {
    expect(satisfiesRequires("foo", { id: "foo", version: "1.2.3" })).toBe(true);
    expect(satisfiesRequires("bar", { id: "foo", version: "1.2.3" })).toBe(false);
  });

  it("caret matches major", () => {
    expect(satisfiesRequires("foo@^1", { id: "foo", version: "1.5.0" })).toBe(true);
    expect(satisfiesRequires("foo@^1", { id: "foo", version: "2.0.0" })).toBe(false);
  });

  it("tilde matches minor", () => {
    expect(satisfiesRequires("foo@~1.2", { id: "foo", version: "1.2.9" })).toBe(true);
    expect(satisfiesRequires("foo@~1.2", { id: "foo", version: "1.3.0" })).toBe(false);
  });

  it("equals matches exact", () => {
    expect(satisfiesRequires("foo@=1.2.3", { id: "foo", version: "1.2.3" })).toBe(true);
    expect(satisfiesRequires("foo@=1.2.3", { id: "foo", version: "1.2.4" })).toBe(false);
  });

  it("scoped ids work", () => {
    expect(
      satisfiesRequires("@squad/foo@^1", { id: "@squad/foo", version: "1.5.0" }),
    ).toBe(true);
  });
});
