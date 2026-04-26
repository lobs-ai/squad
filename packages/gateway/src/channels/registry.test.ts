import { describe, it, expect, vi } from "vitest";
import { ChannelRegistry } from "./registry.js";
import type { ChannelHandle } from "@squad/plugin-sdk";

function fakeChannel(id: string, extras: Partial<ChannelHandle> = {}): ChannelHandle {
  return {
    id,
    start: async () => {},
    stop: async () => {},
    ...extras,
  };
}

describe("ChannelRegistry", () => {
  it("adds a handle and exposes the record + capabilities", () => {
    const onChannelChanged = vi.fn();
    const reg = new ChannelRegistry({ onChannelChanged });
    reg.add(
      fakeChannel("discord-main", {
        kind: "discord",
        label: "Lobs / squad-dev",
        capabilities: { supportsPreview: true, supportsMultiSelect: true, supportsFreeText: true, maxOptions: 4 },
      }),
    );
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe("discord");
    expect(list[0]?.label).toBe("Lobs / squad-dev");
    expect(list[0]?.connected).toBe(false);
    expect(reg.capsFor("discord-main").supportsPreview).toBe(true);
    expect(onChannelChanged).toHaveBeenCalledOnce();
  });

  it("setConnected emits when state transitions", () => {
    const onChannelChanged = vi.fn();
    const reg = new ChannelRegistry({ onChannelChanged });
    reg.add(fakeChannel("c1"));
    onChannelChanged.mockClear();
    reg.setConnected("c1", true);
    expect(onChannelChanged).toHaveBeenCalledOnce();
    reg.setConnected("c1", true);
    expect(onChannelChanged).toHaveBeenCalledOnce(); // no-op when unchanged
    reg.setConnected("c1", false);
    expect(onChannelChanged).toHaveBeenCalledTimes(2);
  });

  it("bind/unbind tracks routes and rejects unknown channels", () => {
    const reg = new ChannelRegistry();
    reg.add(fakeChannel("c1"));
    const b = reg.bind({ channelId: "c1", sessionId: "s1", route: { foo: "bar" } });
    expect(b.id).toMatch(/^cb_/);
    expect(reg.unbind(b.id)).toBe(true);
    expect(reg.unbind("nope")).toBe(false);
    expect(() => reg.bind({ channelId: "missing", sessionId: "s1", route: {} })).toThrow(
      /unknown channel/,
    );
  });

  it("default capabilities are conservative", () => {
    const reg = new ChannelRegistry();
    reg.add(fakeChannel("c1"));
    const caps = reg.capsFor("c1");
    expect(caps.supportsPreview).toBe(false);
    expect(caps.supportsFreeText).toBe(true);
    expect(caps.supportsApprovals).toBe(false);
    expect(caps.maxOptions).toBeGreaterThan(0);
  });
});
