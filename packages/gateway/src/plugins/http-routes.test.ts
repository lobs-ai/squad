import { describe, it, expect } from "vitest";
import { PluginRouteRegistry } from "./http-routes.js";
import type { Logger } from "../logger.js";

function silentLogger(): Logger {
  const fn = () => {};
  return { info: fn, warn: fn, error: fn, debug: fn, trace: fn, fatal: fn } as unknown as Logger;
}

describe("PluginRouteRegistry", () => {
  it("matches exact paths", () => {
    const r = new PluginRouteRegistry(silentLogger());
    r.register("GET", "/oauth/callback", async () => {}, "p");
    expect(r.match("GET", "/oauth/callback")).not.toBeNull();
    expect(r.match("GET", "/oauth/callbac")).toBeNull();
    expect(r.match("POST", "/oauth/callback")).toBeNull();
  });

  it("matches wildcard prefixes and exposes the tail", () => {
    const r = new PluginRouteRegistry(silentLogger());
    r.register("GET", "/oauth/*", async () => {}, "p");
    expect(r.match("GET", "/oauth/callback")?.wildcardPath).toBe("callback");
    expect(r.match("GET", "/oauth/google/cb")?.wildcardPath).toBe("google/cb");
    expect(r.match("GET", "/oauth")?.wildcardPath).toBe(""); // bare prefix counts
    expect(r.match("GET", "/oauthx")).toBeNull();
  });

  it("prefers exact matches over wildcards", () => {
    const r = new PluginRouteRegistry(silentLogger());
    let exactCalled = false;
    let wildCalled = false;
    r.register(
      "GET",
      "/oauth/callback",
      async () => {
        exactCalled = true;
      },
      "p",
    );
    r.register(
      "GET",
      "/oauth/*",
      async () => {
        wildCalled = true;
      },
      "p",
    );
    const m = r.match("GET", "/oauth/callback");
    void m?.route.handler({} as never, {} as never, {} as never);
    expect(exactCalled).toBe(true);
    expect(wildCalled).toBe(false);
  });

  it("rejects duplicate registrations on the same method+path", () => {
    const r = new PluginRouteRegistry(silentLogger());
    r.register("GET", "/x", async () => {}, "p");
    expect(() => r.register("GET", "/x", async () => {}, "p")).toThrow(
      /duplicate plugin route/,
    );
  });

  it("rejects paths that don't start with /", () => {
    const r = new PluginRouteRegistry(silentLogger());
    expect(() => r.register("GET", "x", async () => {}, "p")).toThrow(/must start with/);
  });

  it("removeForPlugin drops only the named plugin's routes", () => {
    const r = new PluginRouteRegistry(silentLogger());
    r.register("GET", "/a", async () => {}, "p1");
    r.register("GET", "/b", async () => {}, "p1");
    r.register("GET", "/c", async () => {}, "p2");
    r.removeForPlugin("p1");
    expect(r.match("GET", "/a")).toBeNull();
    expect(r.match("GET", "/b")).toBeNull();
    expect(r.match("GET", "/c")).not.toBeNull();
    // safe to register the same paths again after removal
    expect(() => r.register("GET", "/a", async () => {}, "p1")).not.toThrow();
  });
});
