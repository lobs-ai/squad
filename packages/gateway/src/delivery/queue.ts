import type { ContentBlock } from "@squad/protocol";

export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: ContentBlock[];
  enqueuedAt: number;
}

export interface DeliveryQueueOptions {
  maxQueued: number;
  collapseDuplicates: boolean;
}

/**
 * Per-session pending-message queue. Shared by both delivery modes; only the
 * drain point differs.
 *
 * - "interrupt" mode drains mid-run via a before_llm_call hook — the queued
 *   messages are injected into the active agent's history and picked up at
 *   the next LLM turn.
 * - "queue" mode drains after_agent_end, one message at a time, each
 *   starting a fresh turn.
 */
export class DeliveryQueue {
  private readonly perSession: Map<string, QueuedMessage[]> = new Map();

  constructor(private readonly options: DeliveryQueueOptions) {}

  enqueue(message: QueuedMessage): { position: number; dropped: boolean } {
    const list = this.perSession.get(message.sessionId) ?? [];
    const trimmed = this.options.collapseDuplicates
      ? this.maybeCollapse(list, message)
      : list;
    trimmed.push(message);
    let dropped = false;
    while (trimmed.length > this.options.maxQueued) {
      trimmed.shift();
      dropped = true;
    }
    this.perSession.set(message.sessionId, trimmed);
    return { position: trimmed.length, dropped };
  }

  /** Drain everything pending for a session. Returns [] if empty. */
  drainAll(sessionId: string): QueuedMessage[] {
    const list = this.perSession.get(sessionId);
    if (!list || list.length === 0) return [];
    this.perSession.delete(sessionId);
    return list;
  }

  /** Pop one message; returns null if empty. */
  drainOne(sessionId: string): QueuedMessage | null {
    const list = this.perSession.get(sessionId);
    if (!list || list.length === 0) return null;
    const next = list.shift()!;
    if (list.length === 0) this.perSession.delete(sessionId);
    return next;
  }

  peek(sessionId: string): QueuedMessage[] {
    return this.perSession.get(sessionId) ?? [];
  }

  size(sessionId: string): number {
    return this.perSession.get(sessionId)?.length ?? 0;
  }

  private maybeCollapse(list: QueuedMessage[], incoming: QueuedMessage): QueuedMessage[] {
    const last = list[list.length - 1];
    if (!last) return list;
    const lastText = last.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const newText = incoming.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (lastText && lastText.trim() === newText.trim()) {
      // Same content arrived twice — drop the duplicate by returning the
      // existing list unchanged, and signal the caller we didn't grow.
      return list;
    }
    return list;
  }
}

/**
 * Render drained messages into a single "user" content block for mid-run
 * injection. Keeps the agent oriented by labeling that these arrived while
 * it was working.
 */
export function renderDrainAsUserBlock(messages: QueuedMessage[]): string {
  if (messages.length === 0) return "";
  const now = Date.now();
  const blocks = messages.map((m, i) => {
    const ageSec = Math.max(0, Math.round((now - m.enqueuedAt) / 1000));
    const text = m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return `--- queued #${i + 1} (${ageSec}s ago) ---\n${text}`;
  });
  return ["[New messages arrived while you were working:]", ...blocks].join("\n\n");
}
