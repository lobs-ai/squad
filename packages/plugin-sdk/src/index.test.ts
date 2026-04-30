import { describe, it, expect } from "vitest";
import { definePlugin } from "./index.js";

describe("definePlugin", () => {
  it("returns the descriptor unchanged", () => {
    const d = definePlugin({
      id: "p1",
      name: "Plugin 1",
      version: "0.0.1",
      kinds: ["tool"],
      register: () => undefined,
    });
    expect(d.id).toBe("p1");
    expect(d.name).toBe("Plugin 1");
    expect(d.kinds).toEqual(["tool"]);
    expect(typeof d.register).toBe("function");
  });

  it("preserves async register and cleanup typings at runtime", async () => {
    let registered = false;
    let cleaned = false;
    const d = definePlugin({
      id: "p2",
      name: "Plugin 2",
      version: "0.0.1",
      kinds: ["skill"],
      register: async () => {
        registered = true;
        return () => {
          cleaned = true;
        };
      },
    });
    const cleanup = (await d.register({
      tools: { register() {} },
      providers: { register() {} },
      subagents: { register() {} },
      routines: { register() {} },
      skills: { register() {} },
      approvalPolicies: { register() {} },
      channels: { register() {} },
      commands: { register() {} },
      toolsets: { register() {} },
      delivery: { register() {} },
      ui: { contribute() {} },
      logger: { info() {}, warn() {}, error() {} },
      config: {},
    })) as () => void;
    expect(registered).toBe(true);
    cleanup();
    expect(cleaned).toBe(true);
  });
});
