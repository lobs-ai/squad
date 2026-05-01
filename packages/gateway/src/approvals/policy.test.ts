import { describe, it, expect } from "vitest";
import { tagMatchPolicy, allowAllPolicy, denyAllPolicy, cascade } from "./policy.js";

describe("approval policy", () => {
  const ctx = {
    sessionId: "s",
    parentSessionId: null,
    toolName: "write_file",
    input: {},
  };

  it("tag-match escalates when a required tag is present", async () => {
    const p = tagMatchPolicy({ requireForTags: ["write"] });
    const out = await p.decide({ ...ctx, tags: ["write", "filesystem"] });
    expect(out).toBe("escalate");
  });

  it("tag-match approves when no required tag is present", async () => {
    const p = tagMatchPolicy({ requireForTags: ["write"] });
    const out = await p.decide({ ...ctx, tags: ["readonly"] });
    expect(out).toBe("approve");
  });

  it("tag-match escalates when the tool name is in requireForTools", async () => {
    const p = tagMatchPolicy({
      requireForTags: [],
      requireForTools: ["write_file"],
    });
    const out = await p.decide({ ...ctx, tags: ["readonly"] });
    expect(out).toBe("escalate");
  });

  it("tag-match approves when neither tag nor tool name matches", async () => {
    const p = tagMatchPolicy({
      requireForTags: ["exec"],
      requireForTools: ["bash"],
    });
    const out = await p.decide({ ...ctx, tags: ["readonly"] });
    expect(out).toBe("approve");
  });

  it("tag-match reads function-form requireForTools dynamically", async () => {
    let gated: string[] = [];
    const p = tagMatchPolicy({
      requireForTags: [],
      requireForTools: () => gated,
    });
    expect(await p.decide({ ...ctx, tags: [] })).toBe("approve");
    gated = ["write_file"];
    expect(await p.decide({ ...ctx, tags: [] })).toBe("escalate");
  });

  it("cascade stops at the first non-escalate verdict", async () => {
    const p = cascade([
      { async decide() { return "escalate"; } },
      allowAllPolicy,
      denyAllPolicy,
    ]);
    const out = await p.decide({ ...ctx, tags: [] });
    expect(out).toBe("approve");
  });

  it("cascade defers to escalate when every policy defers", async () => {
    const p = cascade([
      { async decide() { return "escalate"; } },
      { async decide() { return "escalate"; } },
    ]);
    const out = await p.decide({ ...ctx, tags: [] });
    expect(out).toBe("escalate");
  });
});
