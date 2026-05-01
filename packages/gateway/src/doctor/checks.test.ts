import { mkdtempSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createBuiltinChecks, type BuiltinDeps, type LlmResolutionSnapshot } from "./checks.js";
import { Doctor } from "./engine.js";
import { CORE_DIR, CORE_FILES } from "../agent-prompt.js";

function silentLogger() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    trace: noop,
  } as unknown as import("../logger.js").Logger;
}

interface Harness {
  dir: string;
  workspaceDir: string;
  dataDir: string;
  deps: BuiltinDeps;
  cleanup: () => void;
  setLlm: (snap: LlmResolutionSnapshot) => void;
  setEmbedderKey: (present: boolean) => void;
}

function harness(overrides: Partial<BuiltinDeps> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "squad-doctor-"));
  const workspaceDir = join(dir, "workspace");
  const dataDir = join(dir, "data");
  mkdirSync(workspaceDir);
  mkdirSync(dataDir);

  // In-memory sqlite is enough for integrity_check; we don't need migrations
  // to validate the doctor's PRAGMA call.
  const db = new Database(":memory:");

  let llmSnap: LlmResolutionSnapshot = {
    primaryModel: "anthropic/claude-sonnet-4-6",
    configuredProviders: ["anthropic"],
    resolvedProviders: ["anthropic"],
    missingKeys: [],
  };
  let embedderKey = true;

  const deps: BuiltinDeps = {
    logger: silentLogger(),
    // The default DB has no `sessions` table — the stuck-ingest check will
    // report an error if we hit it. Tests that need it create it themselves.
    db: db as unknown as BuiltinDeps["db"],
    sessions: {
      resetInFlightIngest: () => 0,
    } as unknown as BuiltinDeps["sessions"],
    memcore: { ping: async () => true } as unknown as BuiltinDeps["memcore"],
    embedderKeyPresent: true,
    containerTag: "default",
    squadName: "default",
    workspaceDir,
    dataDir,
    llm: () => llmSnap,
    plugins: { list: () => [] } as unknown as BuiltinDeps["plugins"],
    pluginFailures: () => [],
    mcp: { list: () => [] } as unknown as BuiltinDeps["mcp"],
    mcpFailures: () => [],
    channels: { list: () => [] } as unknown as BuiltinDeps["channels"],
    subagents: {
      pool: {} as unknown as BuiltinDeps["subagents"]["pool"],
      limits: { maxConcurrentGlobal: 8, maxTreeDepth: 3 },
    },
    routines: {
      scheduler: {} as unknown as BuiltinDeps["routines"]["scheduler"],
      isRunning: () => true,
    },
    ...overrides,
  };
  // Splice in dynamic toggles after destructuring, so overrides can replace
  // them but tests get the convenience setters too.
  if (!overrides.embedderKeyPresent && overrides.embedderKeyPresent !== false) {
    Object.defineProperty(deps, "embedderKeyPresent", {
      get: () => embedderKey,
      configurable: true,
    });
  }

  return {
    dir,
    workspaceDir,
    dataDir,
    deps,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
    setLlm: (snap) => {
      llmSnap = snap;
    },
    setEmbedderKey: (present) => {
      embedderKey = present;
    },
  };
}

async function diagnose(deps: BuiltinDeps, id: string) {
  const d = new Doctor({ logger: silentLogger() });
  d.registerAll(createBuiltinChecks(deps));
  const report = await d.run([id]);
  const found = report.diagnoses.find((x) => x.id === id);
  if (!found) throw new Error(`no diagnosis for ${id}`);
  return found;
}

describe("memory checks", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => h.cleanup());

  it("reports ok when memcore ping resolves true", async () => {
    const d = await diagnose(h.deps, "memory.memcore_reachable");
    expect(d.severity).toBe("ok");
  });

  it("reports error when memcore ping resolves false", async () => {
    h.deps.memcore = { ping: async () => false } as unknown as BuiltinDeps["memcore"];
    const d = await diagnose(h.deps, "memory.memcore_reachable");
    expect(d.severity).toBe("error");
  });

  it("reports error when memcore ping throws", async () => {
    h.deps.memcore = {
      ping: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    } as unknown as BuiltinDeps["memcore"];
    const d = await diagnose(h.deps, "memory.memcore_reachable");
    expect(d.severity).toBe("error");
    expect(d.message).toContain("ECONNREFUSED");
  });

  it("warns when no embedder key is present (StubEmbedder fallback)", async () => {
    h.setEmbedderKey(false);
    const d = await diagnose(h.deps, "memory.embedder");
    expect(d.severity).toBe("warn");
    expect(d.remediation).toMatch(/embedding_api_key_env/);
  });
});

describe("llm checks", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => h.cleanup());

  it("errors when no primary model is set", async () => {
    h.setLlm({
      primaryModel: null,
      configuredProviders: [],
      resolvedProviders: [],
      missingKeys: [],
    });
    const d = await diagnose(h.deps, "llm.primary");
    expect(d.severity).toBe("error");
  });

  it("warns when a configured provider has no resolvable key", async () => {
    h.setLlm({
      primaryModel: "anthropic/claude-sonnet-4-6",
      configuredProviders: ["anthropic", "openai"],
      resolvedProviders: ["anthropic"],
      missingKeys: [{ provider: "openai", envVar: "OPENAI_API_KEY", reason: "env not set" }],
    });
    const d = await diagnose(h.deps, "llm.keys");
    expect(d.severity).toBe("warn");
    expect(d.message).toContain("openai");
  });
});

describe("filesystem checks", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => h.cleanup());

  it("flags missing core files as fixable, then auto-seeds them", async () => {
    const before = await diagnose(h.deps, "fs.core_files");
    expect(before.severity).toBe("warn");
    expect(before.fixable).toBe(true);

    const d = new Doctor({ logger: silentLogger() });
    d.registerAll(createBuiltinChecks(h.deps));
    const out = await d.fix("fs.core_files");
    expect(out.ok).toBe(true);

    const after = await diagnose(h.deps, "fs.core_files");
    expect(after.severity).toBe("ok");

    // Sanity: the core dir actually has files now.
    const coreDir = join(h.workspaceDir, CORE_DIR);
    for (const name of CORE_FILES) {
      expect(() => statSync(join(coreDir, name))).not.toThrow();
    }
  });

  it("reports ok when workspace + data dirs are writable", async () => {
    const ws = await diagnose(h.deps, "fs.workspace_writable");
    const data = await diagnose(h.deps, "fs.data_dir_writable");
    expect(ws.severity).toBe("ok");
    expect(data.severity).toBe("ok");
  });
});

describe("plugins / mcp checks", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => h.cleanup());

  it("reports plugin load failures as errors", async () => {
    h.deps.pluginFailures = () => [{ source: "/x/y.js", error: "boom" }];
    const d = await diagnose(h.deps, "plugins.load_failures");
    expect(d.severity).toBe("error");
    expect(d.detail?.failures).toEqual([{ source: "/x/y.js", error: "boom" }]);
  });

  it("reports mcp load failures as errors", async () => {
    h.deps.mcpFailures = () => [{ id: "filesystem", error: "spawn enoent" }];
    const d = await diagnose(h.deps, "mcp.load_failures");
    expect(d.severity).toBe("error");
  });
});

describe("subagents check", () => {
  it("errors when limits are zero", async () => {
    const h = harness({
      subagents: {
        pool: {} as unknown as BuiltinDeps["subagents"]["pool"],
        limits: { maxConcurrentGlobal: 0, maxTreeDepth: 0 },
      },
    });
    try {
      const d = await diagnose(h.deps, "subagents.limits_sane");
      expect(d.severity).toBe("error");
    } finally {
      h.cleanup();
    }
  });
});

describe("routines check", () => {
  it("warns + fixes when scheduler is stopped", async () => {
    let running = false;
    const start = (() => {
      let calls = 0;
      return {
        fn: () => {
          running = true;
          calls += 1;
        },
        get calls() {
          return calls;
        },
      };
    })();
    const h = harness({
      routines: {
        scheduler: { start: start.fn } as unknown as BuiltinDeps["routines"]["scheduler"],
        isRunning: () => running,
      },
    });
    try {
      const before = await diagnose(h.deps, "routines.scheduler_running");
      expect(before.severity).toBe("warn");
      expect(before.fixable).toBe(true);

      const d = new Doctor({ logger: silentLogger() });
      d.registerAll(createBuiltinChecks(h.deps));
      const out = await d.fix("routines.scheduler_running");
      expect(out.ok).toBe(true);
      expect(start.calls).toBe(1);
      expect(running).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
