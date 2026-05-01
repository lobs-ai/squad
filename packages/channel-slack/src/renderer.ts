import type { Task, QuestionRecord, ApprovalRecord } from "@squad/protocol";
import type { ChannelRenderer } from "@squad/channel-sdk";

/**
 * Slack-side rendering shim. The "transport" is intentionally pluggable so
 * tests can run the renderer against a fake transport, and real installs
 * wire the Slack Web API client (or Bolt's `app.client`) without changing
 * this module.
 */
export interface SlackTransport {
  postMessage(input: {
    channelId: string;
    threadTs?: string;
    text?: string;
    blocks?: unknown[];
  }): Promise<{ ts: string }>;
  updateMessage(input: {
    channelId: string;
    ts: string;
    text?: string;
    blocks?: unknown[];
  }): Promise<void>;
}

export interface SlackRendererOptions {
  /** Slack channel id every message lands in (single-channel deployments). */
  channelId: string;
  /** When set, every post lands as a reply in this thread. */
  threadTs?: string;
  transport: SlackTransport;
}

/**
 * Implements the Squad ChannelRenderer over Slack. Streams assistant text by
 * editing a single bot message ("typing-style" updates), renders task lists
 * as `mrkdwn` blocks, and renders ask-user / approval prompts with
 * actionable buttons. Buttons aren't wired here — the channel host is
 * expected to receive Slack interaction events and translate them back into
 * `questions.answer` / `approvals.decide` calls over the protocol.
 */
export class SlackRenderer implements ChannelRenderer {
  /** Per-session message id we keep editing for streaming output. */
  private streamMsg = new Map<string, string>();
  /** Per-session pinned task-list message id. */
  private taskMsg = new Map<string, string>();

  constructor(private readonly opts: SlackRendererOptions) {}

  async onAssistantText(sessionId: string, text: string, opts: { final: boolean }): Promise<void> {
    const existing = this.streamMsg.get(sessionId);
    if (existing) {
      await this.opts.transport.updateMessage({
        channelId: this.opts.channelId,
        ts: existing,
        text,
      });
      if (opts.final) this.streamMsg.delete(sessionId);
      return;
    }
    const result = await this.opts.transport.postMessage({
      channelId: this.opts.channelId,
      ...(this.opts.threadTs ? { threadTs: this.opts.threadTs } : {}),
      text,
    });
    if (!opts.final) this.streamMsg.set(sessionId, result.ts);
  }

  async onToolCall(
    sessionId: string,
    _toolCallId: string,
    name: string,
    input: unknown,
  ): Promise<void> {
    await this.opts.transport.postMessage({
      channelId: this.opts.channelId,
      ...(this.opts.threadTs ? { threadTs: this.opts.threadTs } : {}),
      text: `:wrench: ${name} ${truncate(JSON.stringify(input), 200)}`,
    });
    void sessionId;
  }

  async onToolResult(
    sessionId: string,
    _toolCallId: string,
    result: unknown,
    isError: boolean,
  ): Promise<void> {
    const txt = isError ? `:x: error` : `:white_check_mark: done`;
    await this.opts.transport.postMessage({
      channelId: this.opts.channelId,
      ...(this.opts.threadTs ? { threadTs: this.opts.threadTs } : {}),
      text: `${txt}: ${truncate(typeof result === "string" ? result : JSON.stringify(result), 200)}`,
    });
    void sessionId;
  }

  async renderTaskList(sessionId: string, tasks: Task[]): Promise<void> {
    const blocks = renderTaskListBlocks(tasks);
    const existing = this.taskMsg.get(sessionId);
    if (existing) {
      await this.opts.transport.updateMessage({
        channelId: this.opts.channelId,
        ts: existing,
        blocks,
      });
      return;
    }
    const result = await this.opts.transport.postMessage({
      channelId: this.opts.channelId,
      ...(this.opts.threadTs ? { threadTs: this.opts.threadTs } : {}),
      blocks,
      text: `${tasks.length} task(s)`,
    });
    this.taskMsg.set(sessionId, result.ts);
  }

  async renderAsk(_sessionId: string, question: QuestionRecord): Promise<void> {
    const blocks: unknown[] = [];
    for (const q of question.input.questions) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${q.header}*\n${q.question}` },
      });
      blocks.push({
        type: "actions",
        elements: q.options.map((o, i) => ({
          type: "button",
          text: { type: "plain_text", text: o.label },
          action_id: `squad_q_${question.id}_${i}`,
        })),
      });
    }
    await this.opts.transport.postMessage({
      channelId: this.opts.channelId,
      ...(this.opts.threadTs ? { threadTs: this.opts.threadTs } : {}),
      blocks,
      text: question.input.questions[0]?.question ?? "Question from Squad",
    });
  }

  async renderApproval(_sessionId: string, approval: ApprovalRecord): Promise<void> {
    await this.opts.transport.postMessage({
      channelId: this.opts.channelId,
      ...(this.opts.threadTs ? { threadTs: this.opts.threadTs } : {}),
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Approval needed:* \`${approval.toolName}\`\n\`\`\`${truncate(
              JSON.stringify(approval.input, null, 2),
              500,
            )}\`\`\``,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: "Approve" },
              action_id: `squad_ap_${approval.id}_approve`,
            },
            {
              type: "button",
              style: "danger",
              text: { type: "plain_text", text: "Deny" },
              action_id: `squad_ap_${approval.id}_deny`,
            },
          ],
        },
      ],
      text: `Approval needed: ${approval.toolName}`,
    });
  }
}

function renderTaskListBlocks(tasks: Task[]): unknown[] {
  if (tasks.length === 0) {
    return [{ type: "section", text: { type: "mrkdwn", text: "_(no tasks)_" } }];
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: tasks
          .map((t) => `${statusEmoji(t.status)} ${t.subject}`)
          .join("\n"),
      },
    },
  ];
}

function statusEmoji(s: Task["status"]): string {
  switch (s) {
    case "completed":
      return ":white_check_mark:";
    case "in_progress":
      return ":hourglass_flowing_sand:";
    case "deleted":
      return ":wastebasket:";
    default:
      return ":white_medium_square:";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
