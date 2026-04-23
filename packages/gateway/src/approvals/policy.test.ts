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
