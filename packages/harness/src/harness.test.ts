import { describe, it, expect } from "vitest";
import { runHarnessConformance, validateEventStream } from "./conformance.js";
import { WarmPool } from "./warm-pool.js";
import type {
  HarnessEvent,
  HarnessFactory,
  HarnessSession,
  HarnessStartSpec,
  HarnessTurnInput,
} from "./types.js";

// ── A minimal in-memory harness, standing in for a real adapter ───────────────

let openCount = 0;

class FakeHarness implements HarnessSession {
  readonly kind = "claude" as const;
  readonly caps = {
    inProcessMcp: true,
    perCallApproval: true,
    thinking: true,
    resumeAcrossProcess: true,
  };
  closed = false;
  private hsid: string | undefined;

  constructor(
    readonly sessionId: string,
    private readonly id: string,
  ) {}

  async *runTurn(input: HarnessTurnInput): AsyncIterable<HarnessEvent> {
    this.hsid = this.id;
    yield { t: "session.init", harnessSessionId: this.id, model: "fake", tools: [] };
    yield { t: "turn.start" };
    yield { t: "text.delta", text: `echo:${input.text}` };
    yield { t: "tool.start", id: "tu1", name: "create_task", input: { title: "x" } };
    yield { t: "tool.end", id: "tu1", output: "ok", isError: false };
    yield { t: "turn.end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } };
  }

  harnessSessionId(): string | undefined {
    return this.hsid;
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

const fakeFactory: HarnessFactory = {
  kind: "claude",
  async open(spec) {
    openCount += 1;
    return new FakeHarness(spec.sessionId, `hs-${openCount}`);
  },
};

function spec(overrides: Partial<HarnessStartSpec> = {}): HarnessStartSpec {
  return {
    sessionId: "s1",
    model: "claude-sonnet-4-5",
    auth: { mode: "subscription", token: "tok" },
    cwd: "/work",
    configDir: "/work/.cfg",
    appendSystemPrompt: "SOUL",
    squadTools: { tools: [], execute: async () => "" },
    allowedNativeTools: ["Read", "Edit"],
    surface: "dashboard",
    ...overrides,
  };
}

// ── Conformance ───────────────────────────────────────────────────────────────

describe("conformance", () => {
  it("a well-formed adapter passes the contract", async () => {
    const report = await runHarnessConformance({ factory: fakeFactory, spec: spec() });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.harnessSessionId).toMatch(/^hs-/);
  });

  it("catches a missing session.init", () => {
    const problems = validateEventStream([
      { t: "turn.start" },
      { t: "turn.end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(problems).toContain("first event must be session.init");
  });

  it("catches an unpaired tool.end", () => {
    const problems = validateEventStream([
      { t: "session.init", harnessSessionId: "h", model: "m", tools: [] },
      { t: "turn.start" },
      { t: "tool.end", id: "z", output: "", isError: false },
      { t: "turn.end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(problems).toContain("tool.end 'z' without a matching tool.start");
  });
});

// ── Warm pool ─────────────────────────────────────────────────────────────────

describe("WarmPool", () => {
  it("reuses a compatible parked session instead of re-opening", async () => {
    openCount = 0;
    const pool = new WarmPool({ open: (s) => fakeFactory.open(s, async () => ({ behavior: "allow" })) });

    const s1 = await pool.acquire(spec(), async () => ({ behavior: "allow" }));
    expect(openCount).toBe(1);
    pool.release(s1, spec());

    const s2 = await pool.acquire(spec(), async () => ({ behavior: "allow" }));
    expect(s2).toBe(s1); // same instance — no new open
    expect(openCount).toBe(1);

    await pool.closeAll();
  });

  it("discards and re-opens when the spec changes (e.g. new system prompt)", async () => {
    openCount = 0;
    const pool = new WarmPool({ open: (s) => fakeFactory.open(s, async () => ({ behavior: "allow" })) });

    const s1 = (await pool.acquire(spec(), async () => ({ behavior: "allow" }))) as FakeHarness;
    pool.release(s1, spec());

    const s2 = await pool.acquire(
      spec({ appendSystemPrompt: "SOUL + new memory" }),
      async () => ({ behavior: "allow" }),
    );
    expect(s2).not.toBe(s1);
    expect(s1.closed).toBe(true); // stale warm session was torn down
    expect(openCount).toBe(2);

    await pool.closeAll();
  });

  it("ttlMs<=0 closes immediately on release (warming disabled)", async () => {
    const pool = new WarmPool({
      ttlMs: 0,
      open: (s) => fakeFactory.open(s, async () => ({ behavior: "allow" })),
    });
    const s1 = (await pool.acquire(spec(), async () => ({ behavior: "allow" }))) as FakeHarness;
    pool.release(s1, spec());
    expect(s1.closed).toBe(true);
    expect(pool.size()).toBe(0);
  });

  it("closeAll tears down every parked session", async () => {
    const pool = new WarmPool({ open: (s) => fakeFactory.open(s, async () => ({ behavior: "allow" })) });
    const a = (await pool.acquire(spec({ sessionId: "a" }), async () => ({ behavior: "allow" }))) as FakeHarness;
    const b = (await pool.acquire(spec({ sessionId: "b" }), async () => ({ behavior: "allow" }))) as FakeHarness;
    pool.release(a, spec({ sessionId: "a" }));
    pool.release(b, spec({ sessionId: "b" }));
    expect(pool.size()).toBe(2);
    await pool.closeAll();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(pool.size()).toBe(0);
  });
});
