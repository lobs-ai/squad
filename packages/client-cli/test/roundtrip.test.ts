import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import type { LLMClient, LLMResponse, CreateMessageParams } from "@squad/llm";
import { ToolRegistry } from "@squad/tools";
import { boot, type BootedGateway } from "@squad/gateway";
import type { MemCore } from "memcore";
import { StubMemCore } from "../../gateway/test/fixtures/stub-memcore.js";
import { ProtocolClient } from "../src/protocol-client.js";

class ScriptedClient implements LLMClient {
  constructor(private readonly replies: string[]) {}
  async createMessage(_p: CreateMessageParams): Promise<LLMResponse> {
    const text = this.replies.shift() ?? "ok";
    return {
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
  async streamMessage(
    _p: CreateMessageParams,
    onChunk: (t: string) => void,
  ): Promise<LLMResponse> {
    const text = this.replies.shift() ?? "ok";
    onChunk(text);
    return {
      content: [{ type: "text", text }],
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

describe("ProtocolClient", () => {
  it("starts a session, sends a message, and receives streamed text", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "squad-cli-"));
    booted = await boot({
      config: {
        server: { host: "127.0.0.1", port: 0, data_dir: dataDir, memory_dir: join(dataDir, "memory") },
        auth: { tokens: [{ label: "t", key: "secret", scopes: ["*"] }] },
        llm: { primary: { model: "claude-sonnet-4-5" }, fallbacks: [], providers: {} },
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
      clientOverride: new ScriptedClient(["hello world"]),
      memcoreOverride: new StubMemCore() as unknown as MemCore,
    });
    await new Promise<void>((resolve) => booted!.handle.http.listen(0, "127.0.0.1", resolve));
    const port = (booted.handle.http.address() as AddressInfo).port;

    const client = new ProtocolClient({ url: `ws://127.0.0.1:${port}/ws`, token: "secret" });
    await client.connect();
    const { session } = await client.request("session.start", { title: "cli test" });

    const deltas: string[] = [];
    client.onEvent((topic, data) => {
      if (topic.startsWith("chat.text_delta/")) {
        deltas.push((data as { delta: string }).delta);
      }
    });

    await client.subscribe([`chat.*/${session.id}`]);
    await client.request("chat.send", { sessionId: session.id, content: "hi" });

    // Give events time to flush.
    await new Promise((r) => setTimeout(r, 50));

    expect(deltas.join("")).toContain("hello world");

    client.close();
  }, 10000);
});
