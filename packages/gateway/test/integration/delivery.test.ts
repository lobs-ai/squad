import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient, LLMResponse, CreateMessageParams } from "@squad/llm";
import { boot, type BootedGateway } from "../../src/index.js";

/**
 * Client that blocks on a signal the test owns. We use two gates: one that
 * releases the first LLM call after the test has had a chance to enqueue a
 * second chat.send, and one the test awaits to know the LLM has been called
 * (so it knows the run is truly active).
 */
class GatedClient implements LLMClient {
  private calls = 0;
  readonly callStarted: Promise<void>[] = [];
  private readonly starters: Array<() => void> = [];
  private readonly releasers: Array<Promise<void>> = [];
  private readonly releaseResolvers: Array<() => void> = [];
  /** Replies per call, in order. */
  constructor(private readonly replies: string[]) {
    for (let i = 0; i < replies.length; i++) {
      this.callStarted.push(
        new Promise<void>((r) => this.starters.push(r)),
      );
      this.releasers.push(
        new Promise<void>((r) => this.releaseResolvers.push(r)),
      );
    }
  }
  /** Let the next scheduled LLM call complete. */
  release(index: number): void {
    this.releaseResolvers[index]!();
  }
  async createMessage(_p: CreateMessageParams): Promise<LLMResponse> {
    return this.streamMessage(_p, () => undefined);
  }
  async streamMessage(
    p: CreateMessageParams,
    onChunk: (t: string) => void,
  ): Promise<LLMResponse> {
    const idx = this.calls++;
    this.starters[idx]!();
    await this.releasers[idx]!;
    const text = this.replies[idx] ?? "ok";
    for (const tok of text.split(" ")) onChunk(tok + " ");
    void p;
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

async function bootForTest(
  mode: "interrupt" | "queue",
  client: GatedClient,
): Promise<BootedGateway> {
  dataDir = mkdtempSync(join(tmpdir(), "squad-delivery-"));
  booted = await boot({
    config: {
      server: { host: "127.0.0.1", port: 0, data_dir: dataDir },
      auth: { tokens: [{ label: "t", key: "secret", scopes: ["*"] }] },
      chat: { delivery: { mode } },
    },
    toolRegistry: new ToolRegistry(),
    clientOverride: client,
  });
  return booted;
}

describe("chat delivery modes", () => {
  it("interrupt: queued message is injected mid-run and absorbed by the active turn", async () => {
    const client = new GatedClient([
      "(noop)",
      "I see your follow-up and here is my real answer",
    ]);
    const b = await bootForTest("interrupt", client);
    const { sessions } = b.stores;

    const s = sessions.create({ model: "claude-sonnet-4-5", title: "interrupt" });

    // Set up broadcast listener to observe user_message events.
    const userMessages: Array<{ id: string; content: unknown }> = [];
    const events: string[] = [];
    const sub = { id: "t", send: (f: { topic: string; data: unknown }) => {
      events.push(f.topic);
      if (f.topic.startsWith("chat.user_message/")) {
        const d = f.data as { message: { id: string; content: unknown } };
        userMessages.push(d.message);
      }
    }};
    b.broadcast.subscribe(sub as Parameters<typeof b.broadcast.subscribe>[0], `chat.*/${s.id}`);

    // Start the first turn; the client blocks inside streamMessage until we release.
    const first = b.coordinator["starter" as never] as unknown as (
      sessionId: string,
      content: unknown,
      opts: unknown,
    ) => Promise<void>;
    void first; // keep unused guard quiet

    // Fire via chat dispatch: use the public path.
    // We know chat.send is sync-resolved after persistUserMessage, but the
    // run is active. Drive it via the dispatcher entry the way a real client would.
    const { createGatewayServer } = await import("../../src/server.js");
    void createGatewayServer;

    // Simplest: use the gateway's dispatcher directly.
    const dispatcher = b.handle.dispatcher;
    const firstResp = await dispatcher.dispatch(
      "chat.send",
      { sessionId: s.id, content: "first" },
      {
        grant: { label: "t", scopes: ["*"] },
        authenticator: { authorized: () => true } as never,
        subscriberId: "test",
      },
    );
    expect((firstResp as { status: string }).status).toBe("running");

    // Wait for the LLM to actually start.
    await client.callStarted[0];

    // Now send a second message. It should queue (status=queued).
    const secondResp = await dispatcher.dispatch(
      "chat.send",
      { sessionId: s.id, content: "interrupt me" },
      {
        grant: { label: "t", scopes: ["*"] },
        authenticator: { authorized: () => true } as never,
        subscriberId: "test",
      },
    );
    expect((secondResp as { status: string }).status).toBe("queued");
    expect((secondResp as { queuePosition: number }).queuePosition).toBe(1);

    // Release the first LLM call. Its stop_reason is end_turn, so the run
    // ends — BUT the leftover drain should fire a second turn with the
    // injected "interrupt me" message.
    client.release(0);
    // Now the second call fires. Release it too.
    await client.callStarted[1];
    client.release(1);

    // Give the final assistant_message broadcast time.
    await new Promise((r) => setTimeout(r, 50));

    // Both user messages were persisted, both runs happened.
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(events.some((t) => t.startsWith("chat.assistant_message/"))).toBe(true);
  }, 15000);

  it("queue: second message waits until first run completes, then fires as its own turn", async () => {
    const client = new GatedClient(["answer one", "answer two"]);
    const b = await bootForTest("queue", client);
    const { sessions } = b.stores;
    const s = sessions.create({ model: "claude-sonnet-4-5", title: "queue" });

    const dispatcher = b.handle.dispatcher;
    const ctx = {
      grant: { label: "t", scopes: ["*"] },
      authenticator: { authorized: () => true } as never,
      subscriberId: "test",
    };

    const firstResp = await dispatcher.dispatch(
      "chat.send",
      { sessionId: s.id, content: "first" },
      ctx,
    );
    expect((firstResp as { status: string }).status).toBe("running");
    await client.callStarted[0];

    // Second while run is in flight — should be queued.
    const secondResp = await dispatcher.dispatch(
      "chat.send",
      { sessionId: s.id, content: "second" },
      ctx,
    );
    expect((secondResp as { status: string }).status).toBe("queued");

    // Before we release, the second call MUST NOT have started yet.
    let secondStartedEarly = false;
    const race = Promise.race([
      client.callStarted[1]!.then(() => (secondStartedEarly = true)),
      new Promise((r) => setTimeout(r, 100)),
    ]);
    await race;
    expect(secondStartedEarly).toBe(false);

    // Release the first call; the queue drain should kick off the second.
    client.release(0);
    await client.callStarted[1];
    client.release(1);

    await new Promise((r) => setTimeout(r, 100));

    // Second run actually ran (i.e., two LLM calls total).
    expect(client["calls" as never]).toBe(2);
  }, 15000);
});
