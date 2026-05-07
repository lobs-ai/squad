import { describe, it, expect, vi } from "vitest";
import { AppRegistry } from "./registry.js";
import { matchAppPath } from "./proxy.js";
import type { Logger } from "../logger.js";

function silentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => silentLogger(),
  } as unknown as Logger;
}

describe("AppRegistry", () => {
  it("rejects names that don't match the slug regex", () => {
    const reg = new AppRegistry(silentLogger());
    expect(() => reg.register({ name: "Bad Name", title: "x", port: 1234 })).toThrow(
      /lowercase, digits, hyphens/,
    );
    expect(() => reg.register({ name: "/foo", title: "x", port: 1234 })).toThrow();
    // Underscores are out — slugs are URL segments.
    expect(() => reg.register({ name: "snake_case", title: "x", port: 1234 })).toThrow();
  });

  it("rejects out-of-range ports", () => {
    const reg = new AppRegistry(silentLogger());
    expect(() => reg.register({ name: "x", title: "x", port: 0 })).toThrow();
    expect(() => reg.register({ name: "x", title: "x", port: 70000 })).toThrow();
  });

  it("rejects duplicate names — agents must unexpose first", () => {
    const reg = new AppRegistry(silentLogger());
    reg.register({ name: "weather", title: "Weather", port: 8001 });
    expect(() => reg.register({ name: "weather", title: "Weather 2", port: 8002 })).toThrow(
      /already registered/,
    );
  });

  it("starts apps in `unknown` health and lets the prober flip them", () => {
    const onHealth = vi.fn();
    const reg = new AppRegistry(silentLogger(), { onHealthChanged: onHealth });
    const rec = reg.register({ name: "weather", title: "Weather", port: 8001 });
    expect(rec.health).toBe("unknown");
    expect(rec.lastProbeAt).toBeNull();

    reg.setHealth("weather", "healthy", { version: "1.0.0" });
    expect(reg.get("weather")?.health).toBe("healthy");
    expect(reg.get("weather")?.info).toEqual({ version: "1.0.0" });
    expect(onHealth).toHaveBeenCalledTimes(1);

    // Repeated same-state probes don't fire onHealthChanged.
    reg.setHealth("weather", "healthy", null);
    expect(onHealth).toHaveBeenCalledTimes(1);
  });

  it("dropForSession only drops session-scoped registrations", () => {
    const reg = new AppRegistry(silentLogger());
    reg.register({ name: "long-lived", title: "x", port: 1, scope: "persist", sessionId: "s1" });
    reg.register({ name: "ephemeral", title: "x", port: 2, scope: "session", sessionId: "s1" });
    reg.register({ name: "other-session", title: "x", port: 3, scope: "session", sessionId: "s2" });

    const dropped = reg.dropForSession("s1");
    expect(dropped).toEqual(["ephemeral"]);
    expect(reg.get("long-lived")).not.toBeNull();
    expect(reg.get("ephemeral")).toBeNull();
    expect(reg.get("other-session")).not.toBeNull();
  });
});

describe("matchAppPath", () => {
  it("matches /apps/<name> with no tail", () => {
    expect(matchAppPath("/apps/weather")).toEqual({ name: "weather", upstreamPath: "/" });
  });

  it("matches /apps/<name>/ as the same upstream root", () => {
    expect(matchAppPath("/apps/weather/")).toEqual({ name: "weather", upstreamPath: "/" });
  });

  it("captures the rest of the path verbatim", () => {
    expect(matchAppPath("/apps/weather/v1/forecast")).toEqual({
      name: "weather",
      upstreamPath: "/v1/forecast",
    });
  });

  it("rejects non-slug names — uppercase and special chars", () => {
    expect(matchAppPath("/apps/Weather")).toBeNull();
    expect(matchAppPath("/apps/weather!")).toBeNull();
    expect(matchAppPath("/apps/")).toBeNull();
    expect(matchAppPath("/health")).toBeNull();
  });
});
