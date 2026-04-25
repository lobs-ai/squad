import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import { boot, type BootedGateway } from "../../src/index.js";

let booted: BootedGateway | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (booted) await booted.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  booted = null;
  dataDir = null;
});

async function bootForTest(timeoutSeconds = 120): Promise<BootedGateway> {
  dataDir = mkdtempSync(join(tmpdir(), "squad-ask-"));
  booted = await boot({
    config: {
      server: { host: "127.0.0.1", port: 0, data_dir: dataDir, memory_dir: join(dataDir, "memory") },
      auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
      llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
      subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
      policy: {
        approvals: {
          default: "tag-match",
          require_for_tags: ["write", "exec", "network"],
          timeout_seconds: timeoutSeconds,
        },
      },
      plugins: [],
      channels: {},
    },
    toolRegistry: new ToolRegistry(),
  });
  return booted;
}

describe("ask-user primitive", () => {
  it("resolves when a client answers", async () => {
    const b = await bootForTest();
    const { questions, sessions } = b.stores;
    const s = sessions.create({ model: "claude-sonnet-4-5", title: "ask" });

    const { id, done } = questions.ask({
      sessionId: s.id,
      askedBy: "tool-123",
      input: {
        allowCustom: true,
        questions: [
          {
            header: "Auth method",
            question: "Which one?",
            multiSelect: false,
            options: [
              { label: "OAuth (Recommended)", description: "Recommended" },
              { label: "API key", description: "Simpler" },
            ],
          },
        ],
      },
    });

    // Answer after a tick.
    setTimeout(() => {
      questions.answer(s.id, id, { "Which one?": "OAuth (Recommended)" });
    }, 5);

    const record = await done;
    expect(record.status).toBe("answered");
    expect(record.answers).toEqual({ "Which one?": "OAuth (Recommended)" });
  });

  it("times out when no client answers", async () => {
    const b = await bootForTest();
    const { questions, sessions } = b.stores;
    const s = sessions.create({ model: "claude-sonnet-4-5", title: "ask" });

    const { done } = questions.ask({
      sessionId: s.id,
      askedBy: "tool-x",
      input: {
        allowCustom: true,
        timeoutSeconds: 1,
        questions: [
          {
            header: "Pick",
            question: "A or B?",
            multiSelect: false,
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
          },
        ],
      },
    });

    const record = await done;
    expect(record.status).toBe("timed_out");
    expect(record.answers).toBeNull();
  }, 5000);
});
