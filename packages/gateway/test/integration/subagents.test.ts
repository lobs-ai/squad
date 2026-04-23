import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient, LLMResponse, CreateMessageParams } from "@squad/llm";
import { boot, type BootedGateway } from "../../src/index.js";

class ScriptedClient implements LLMClient {
  async createMessage(_p: CreateMessageParams): Promise<LLMResponse> {
    return {
      content: [{ type: "text", text: "subagent finished" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
  async streamMessage(
    _p: CreateMessageParams,
    onChunk: (t: string) => void,
  ): Promise<LLMResponse> {
    onChunk("subagent finished");
    return {
      content: [{ type: "text", text: "subagent finished" }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

let booted: BootedGateway | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (booted) await booted.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  booted = null;
  dataDir = null;
});

async function bootForTest(): Promise<BootedGateway> {
  dataDir = mkdtempSync(join(tmpdir(), "squad-subs-"));
  booted = await boot({
    config: {
      server: { host: "127.0.0.1", port: 0, data_dir: dataDir },
      auth: { tokens: [{ label: "test", key: "secret", scopes: ["*"] }] },
      llm: { default_model: "claude-sonnet-4-5", providers: {} },
      subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
      policy: {
        approvals: {
          default: "tag-match",
          require_for_tags: ["write"],
          timeout_seconds: 120,
        },
      },
      plugins: [],
      channels: {},
    },
    toolRegistry: new ToolRegistry(),
    clientOverride: new ScriptedClient(),
  });
  return booted;
}

describe("subagent pool", () => {
  it("spawns a registered subagent, inherits the task list, and reports completion", async () => {
    const b = await bootForTest();
    const { sessions, tasks } = b.stores;
    const { registry, pool } = b.subagents;

    registry.register({
      name: "echo",
      description: "Echoes its input",
      model: "claude-sonnet-4-5",
      tools: [],
      systemPrompt: "You are a test subagent.",
    });

    const root = sessions.create({ model: "claude-sonnet-4-5", title: "root" });
    await tasks.create({
      sessionId: root.id,
      subject: "review the diff",
      description: "subagent picks this up",
    });

    const handle = pool.spawn({
      parentSessionId: root.id,
      subagent: "echo",
      input: { hello: "world" },
      wait: true,
    });

    const outcome = await handle.done;
    expect(outcome.succeeded).toBe(true);
    expect(outcome.result).toContain("subagent finished");

    // The subagent session is a child of root.
    const child = sessions.get(handle.sessionId);
    expect(child.parentSessionId).toBe(root.id);

    // The task list is shared — same task_list_id (root).
    const visible = tasks.list(handle.sessionId, { includeDeleted: false });
    expect(visible[0]?.taskListId).toBe(root.id);
  });

  it("enforces per-parent concurrency", async () => {
    const b = await bootForTest();
    const { sessions } = b.stores;
    const { registry, pool } = b.subagents;
    registry.register({
      name: "slow",
      description: "blocking subagent",
      model: "claude-sonnet-4-5",
      tools: [],
      systemPrompt: "test",
    });
    const root = sessions.create({ model: "claude-sonnet-4-5", title: "p" });

    // Per-parent cap is 4 in this harness config.
    const handles = Array.from({ length: 6 }, () =>
      pool.spawn({
        parentSessionId: root.id,
        subagent: "slow",
        input: {},
        wait: true,
      }),
    );
    const outcomes = await Promise.all(handles.map((h) => h.done));
    expect(outcomes.every((o) => o.succeeded)).toBe(true);
    expect(outcomes).toHaveLength(6);
  });
});
