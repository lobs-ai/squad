import type { Task, QuestionRecord, ApprovalRecord } from "@squad/protocol";

/**
 * Renderer contract. A channel implements the subset it can render;
 * the `capabilities` it declares tells the gateway which bits to send.
 */
export interface ChannelRenderer {
  /** Outbound assistant text (either a stream chunk or the final message). */
  onAssistantText(sessionId: string, text: string, opts: { final: boolean }): void | Promise<void>;

  /** A tool call began. */
  onToolCall?(sessionId: string, toolCallId: string, name: string, input: unknown): void | Promise<void>;

  /** A tool call finished. */
  onToolResult?(sessionId: string, toolCallId: string, result: unknown, isError: boolean): void | Promise<void>;

  /** Render or re-render the task list for a session tree. */
  renderTaskList?(sessionId: string, tasks: Task[]): void | Promise<void>;

  /** Handle an inbound task action (claim/complete) from the channel's UI. */
  handleTaskAction?(taskId: string, action: "claim" | "complete" | "delete"): void | Promise<void>;

  /** Render an ask-user question; the channel collects the answer out-of-band. */
  renderAsk?(sessionId: string, question: QuestionRecord): void | Promise<void>;

  /** Render an approval request; the channel collects the decision out-of-band. */
  renderApproval?(sessionId: string, approval: ApprovalRecord): void | Promise<void>;
}
