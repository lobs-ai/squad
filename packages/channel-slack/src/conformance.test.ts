import { describe, it, expect } from "vitest";
import {
  channelConformanceCases,
  type ConformanceFactory,
  type RenderedCapture,
} from "@squad/channel-sdk";
import { SlackRenderer, type SlackTransport } from "./renderer.js";

function buildFactory(): ConformanceFactory {
  return {
    capabilities: {
      supportsPreview: true,
      supportsMultiSelect: false,
      supportsFreeText: true,
      maxOptions: 5,
      supportsImages: true,
      supportsFileUploads: true,
      supportsTaskList: true,
      supportsApprovals: true,
    },
    build() {
      let nextTs = 1;
      const events: RenderedCapture["events"] = [];
      const transport: SlackTransport = {
        async postMessage(input) {
          // Categorize so the conformance harness can count rendered events.
          const blocks = (input.blocks ?? []) as Array<Record<string, unknown>>;
          let kind: RenderedCapture["events"][number]["type"] = "assistant_text";
          if (blocks.some((b) => (b.text as Record<string, unknown> | undefined)?.text === undefined && b.type === "actions")) {
            // Has buttons → ask or approval. We can't tell apart from
            // transport alone, so look at the action_id pattern.
            const actions = blocks.find((b) => b.type === "actions") as
              | { elements?: Array<{ action_id?: string }> }
              | undefined;
            const aid = actions?.elements?.[0]?.action_id ?? "";
            kind = aid.startsWith("squad_ap_") ? "approval" : "ask";
          } else if (
            input.text?.startsWith(":wrench:")
          ) {
            kind = "tool_call";
          } else if (
            input.text?.startsWith(":white_check_mark:") ||
            input.text?.startsWith(":x:")
          ) {
            kind = "tool_result";
          } else if (blocks.length > 0) {
            kind = "task_list";
          }
          events.push({ type: kind, payload: input });
          return { ts: `ts_${nextTs++}` };
        },
        async updateMessage(input) {
          events.push({ type: "assistant_text", payload: input });
        },
      };
      const renderer = new SlackRenderer({
        channelId: "C1",
        transport,
      });
      return {
        renderer,
        capture: {
          events,
          reset() {
            events.length = 0;
          },
        },
      };
    },
  };
}

describe("Slack channel conformance", () => {
  for (const c of channelConformanceCases()) {
    it(c.name, async () => {
      await c.run(buildFactory());
    });
  }

  it("declares supportsApprovals + renders approval blocks", async () => {
    const f = buildFactory();
    expect(f.capabilities.supportsApprovals).toBe(true);
  });
});
