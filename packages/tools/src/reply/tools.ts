import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { ReplyBackend } from "./backend.js";

function sessionIdFrom(ctx: ToolContext): string {
  const sid = (ctx.meta?.sessionId as string | undefined) ?? undefined;
  if (!sid) throw new Error("reply requires `sessionId` in the agent context");
  return sid;
}

interface ReplyInput extends Record<string, unknown> {
  content: string;
  channel_id?: string;
}

/**
 * `reply` — send a message to the channel this conversation is happening on.
 *
 * Exposed only on channel turns (Discord, etc.). On those turns the agent's
 * own turn text is NOT delivered anywhere the user sees — this tool is the
 * only way to say something. It can be called any number of times (a quick
 * ack now, results later) or not at all (silence is valid).
 */
export class ReplyTool extends BaseTool<ReplyInput> {
  readonly name = "reply";
  readonly description = [
    "Send a message to the channel this conversation is on (e.g. the Discord",
    "channel the user messaged you from).",
    "",
    "IMPORTANT: on a channel, nothing you write outside this tool is delivered —",
    "your turn's text stays internal. `reply` is the only way to actually say",
    "something to the user.",
    "",
    "Call it as many times as you like: send a quick acknowledgement first, then",
    "follow up with the result — or send nothing at all if no response is",
    "warranted. By default it posts to the originating channel; pass `channel_id`",
    "to target a different channel/thread on the same platform.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      content: {
        type: "string",
        description: "The message text to send to the channel.",
      },
      channel_id: {
        type: "string",
        description:
          "Optional: post to this channel/thread id instead of the originating channel (same platform).",
      },
    },
    required: ["content"],
  };
  readonly tags = ["network"] as const;

  constructor(private readonly backend: ReplyBackend) {
    super();
  }

  async run(input: ReplyInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const content = input.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("reply requires non-empty `content`");
    }
    const result = await this.backend.reply({
      sessionId: sessionIdFrom(ctx),
      content,
      ...(input.channel_id ? { channelId: input.channel_id } : {}),
    });
    return {
      result: JSON.stringify({ sent: true, ...result }),
    };
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerReplyTool(
  registry: { register(tool: AnyTool): unknown },
  backend: ReplyBackend,
): void {
  registry.register(new ReplyTool(backend) as unknown as AnyTool);
}
