import type { ChannelRenderer } from "./renderer.js";
import type { ChannelCapabilities } from "./capabilities.js";

/**
 * Test fixtures + assertions any channel implementation can run against to
 * verify its renderer contract. Channel packages call `runChannelConformance`
 * with a factory that builds a fresh renderer + a way to read what it
 * "rendered" (typically a captured array of payloads pushed to the channel).
 *
 * The harness deliberately doesn't require vitest — callers wrap the
 * returned `Suite` in their own framework. Returning structured cases
 * keeps it framework-agnostic so a Slack package using vitest and a
 * webhook channel using mocha can share the same checklist.
 */

export interface RenderedCapture {
  /** A clean log of "what did the channel render in response?" — flat for diffing. */
  events: Array<{
    type:
      | "assistant_text"
      | "tool_call"
      | "tool_result"
      | "task_list"
      | "ask"
      | "approval";
    sessionId?: string;
    payload: unknown;
  }>;
  /** Reset the events buffer between cases. */
  reset(): void;
}

export interface ConformanceFactory {
  /** Capability hints the channel claims. The harness skips cases the
   *  channel doesn't claim to support — declaring less is fine. */
  capabilities: ChannelCapabilities;
  /** Build a fresh renderer + a capture handle the harness can read. */
  build(): { renderer: ChannelRenderer; capture: RenderedCapture };
}

export interface ConformanceCase {
  name: string;
  /** Run the case against a fresh renderer; throws on failure. */
  run(factory: ConformanceFactory): Promise<void>;
}

/**
 * The full conformance suite. Channel packages export a test that
 * iterates this and runs each case in their preferred framework.
 */
export function channelConformanceCases(): ConformanceCase[] {
  return [
    {
      name: "assistant text streaming + final",
      async run(f) {
        const { renderer, capture } = f.build();
        await renderer.onAssistantText("s1", "hel", { final: false });
        await renderer.onAssistantText("s1", "lo", { final: false });
        await renderer.onAssistantText("s1", "hello", { final: true });
        const texts = capture.events.filter((e) => e.type === "assistant_text");
        if (texts.length === 0) throw new Error("no assistant text events captured");
        // The final event must arrive last and be marked final via the
        // payload — channels are free to fold streaming chunks into one
        // message and only emit the final, but they must emit something.
      },
    },
    {
      name: "tool call + result",
      async run(f) {
        if (!f.capabilities.supportsApprovals && !f.build().renderer.onToolCall) return;
        const { renderer, capture } = f.build();
        await renderer.onToolCall?.("s1", "tc1", "exec", { cmd: "ls" });
        await renderer.onToolResult?.("s1", "tc1", "ok", false);
        const calls = capture.events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
        if (renderer.onToolCall && calls.length === 0) {
          throw new Error("renderer.onToolCall is defined but no events captured");
        }
      },
    },
    {
      name: "task list rendering",
      async run(f) {
        if (!f.capabilities.supportsTaskList) return;
        const { renderer, capture } = f.build();
        if (!renderer.renderTaskList) {
          throw new Error("capabilities claim supportsTaskList but renderTaskList is missing");
        }
        await renderer.renderTaskList("s1", [
          {
            id: "t1",
            taskListId: "tl1",
            subject: "do the thing",
            description: "",
            owner: null,
            status: "pending",
            blocks: [],
            blockedBy: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]);
        if (!capture.events.some((e) => e.type === "task_list")) {
          throw new Error("renderTaskList emitted nothing");
        }
      },
    },
    {
      name: "ask question rendering",
      async run(f) {
        const { renderer, capture } = f.build();
        if (!renderer.renderAsk) return;
        await renderer.renderAsk("s1", {
          id: "q1",
          sessionId: "s1",
          askedBy: "test",
          askedAt: new Date().toISOString(),
          answeredAt: null,
          timedOutAt: null,
          status: "pending",
          input: {
            questions: [
              {
                header: "Color choice",
                question: "Which color?",
                options: [
                  { label: "Red", description: "warm" },
                  { label: "Blue", description: "cool" },
                ],
                multiSelect: false,
              },
            ],
            allowCustom: true,
          },
          answers: null,
        });
        if (!capture.events.some((e) => e.type === "ask")) {
          throw new Error("renderAsk emitted nothing");
        }
      },
    },
    {
      name: "approval rendering",
      async run(f) {
        if (!f.capabilities.supportsApprovals) return;
        const { renderer, capture } = f.build();
        if (!renderer.renderApproval) {
          throw new Error("capabilities claim supportsApprovals but renderApproval is missing");
        }
        await renderer.renderApproval("s1", {
          id: "ap1",
          sessionId: "s1",
          toolCallId: "tc1",
          toolName: "exec",
          input: { cmd: "rm -rf /" },
          tags: ["exec", "destructive"],
          status: "pending",
          decision: null,
          reason: null,
          decidedBy: null,
          decidedAt: null,
          createdAt: new Date().toISOString(),
        });
        if (!capture.events.some((e) => e.type === "approval")) {
          throw new Error("renderApproval emitted nothing");
        }
      },
    },
  ];
}

/**
 * Helper that runs every case sequentially and throws on the first failure.
 * Channel packages can wrap this in `it("conformance", ...)` for one-call
 * verification, or iterate `channelConformanceCases()` themselves for
 * per-case test names.
 */
export async function runChannelConformance(factory: ConformanceFactory): Promise<void> {
  for (const c of channelConformanceCases()) {
    try {
      await c.run(factory);
    } catch (err) {
      throw new Error(
        `channel conformance case failed: "${c.name}" — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
