import type { ContentBlock, MessageRecord } from "@squad/protocol";
import { getHookRegistry, type Session } from "@squad/runner";
import type { MessageStore } from "./db/messages.js";
import type { Broadcast } from "./broadcast.js";
import type { Logger } from "./logger.js";

/**
 * Convert wire ContentBlocks into the LLM's content shape for message
 * history. tool_result blocks need camelCase→snake_case remap (the
 * Anthropic wire format uses tool_use_id/is_error); text and tool_use
 * blocks pass through unchanged.
 */
export function toLLMContent(
  blocks: ContentBlock[],
): string | Array<Record<string, unknown>> {
  if (blocks.length === 1 && blocks[0]!.type === "text") return blocks[0]!.text;
  return blocks.map((b) => {
    if (b.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
    }
    return b as unknown as Record<string, unknown>;
  });
}

/**
 * Inverse of toLLMContent — fold runner/Anthropic-shaped content back into
 * wire ContentBlocks for persistence.
 */
export function llmToWireBlocks(
  content: string | Array<Record<string, unknown>>,
): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((b) => {
    if (b.type === "tool_result") {
      return {
        type: "tool_result" as const,
        toolUseId: b.tool_use_id as string,
        content: b.content as string | Array<unknown>,
        ...(b.is_error ? { isError: true } : {}),
      };
    }
    return b as unknown as ContentBlock;
  });
}

/**
 * Incremental persister: walks Session._ref() forward from a moving
 * watermark and writes any new assistant + tool messages to disk. Designed
 * so a crash between flushes only loses the in-flight LLM turn — everything
 * before it is durable.
 *
 * Lifecycle:
 *   - Construct with `messageCountBefore` (the size of session._ref() at
 *     run start, so existing history isn't re-persisted).
 *   - Call `flush()` whenever the runner has finished a turn (we wire this
 *     to the `before_llm_call` hook in runs.ts — every iteration boundary).
 *   - Call `finalize(fallbackText)` once at end-of-run. This does a final
 *     flush and broadcasts `chat.assistant_message`. Idempotent.
 */
export class RunPersister {
  private watermark: number;
  private finalAssistant: MessageRecord | null = null;
  private finalized = false;

  constructor(
    private readonly opts: {
      messages: MessageStore;
      broadcast: Broadcast;
      sessionId: string;
      session: Session;
      runId: string;
      messageCountBefore: number;
    },
  ) {
    this.watermark = opts.messageCountBefore;
  }

  /**
   * Persist any messages appended to the session since the last flush.
   * Returns the number of messages written. Cheap when there's nothing new.
   */
  flush(): number {
    if (this.finalized) return 0;
    const all = this.opts.session._ref();
    if (all.length <= this.watermark) return 0;
    const slice = all.slice(this.watermark);
    let written = 0;
    for (const m of slice) {
      if (m.role === "assistant") {
        this.finalAssistant = this.opts.messages.append({
          sessionId: this.opts.sessionId,
          role: "assistant",
          content: llmToWireBlocks(m.content),
        });
        written++;
      } else if (m.role === "user" && Array.isArray(m.content)) {
        const toolResults = m.content.filter(
          (b) => (b as { type?: string }).type === "tool_result",
        );
        if (toolResults.length === 0) continue;
        this.opts.messages.append({
          sessionId: this.opts.sessionId,
          role: "tool",
          content: llmToWireBlocks(toolResults),
        });
        written++;
      }
    }
    this.watermark = all.length;
    return written;
  }

  /**
   * Final flush + broadcast. If the runner produced no assistant message,
   * `fallbackText` is persisted as a safety net so callers still see a
   * reply.
   */
  finalize(fallbackText: string): MessageRecord {
    this.flush();
    let final = this.finalAssistant;
    if (!final) {
      final = this.opts.messages.append({
        sessionId: this.opts.sessionId,
        role: "assistant",
        content: [{ type: "text", text: fallbackText }],
      });
    }
    this.opts.broadcast.publish(`chat.assistant_message/${this.opts.sessionId}`, {
      sessionId: this.opts.sessionId,
      message: final,
      runId: this.opts.runId,
    });
    this.finalized = true;
    return final;
  }
}

/**
 * One-shot wrapper around RunPersister for callers that don't need
 * incremental flushing. Equivalent to constructing a persister and calling
 * `finalize()` once.
 */
export function persistRunMessages(args: {
  messages: MessageStore;
  broadcast: Broadcast;
  sessionId: string;
  session: Session;
  messageCountBefore: number;
  runId: string;
  fallbackText: string;
}): MessageRecord {
  const persister = new RunPersister({
    messages: args.messages,
    broadcast: args.broadcast,
    sessionId: args.sessionId,
    session: args.session,
    runId: args.runId,
    messageCountBefore: args.messageCountBefore,
  });
  return persister.finalize(args.fallbackText);
}

/**
 * Per-runId map of active persisters. The shared `before_llm_call` hook
 * (installed once via {@link ensureIncrementalFlushHook}) looks up the
 * persister for the firing run and flushes new messages so each completed
 * turn lands on disk before the next LLM call. A crash mid-run now only
 * loses the in-flight turn, not the whole run's tool calls.
 */
const activePersisters = new Map<string, RunPersister>();
let flushHookInstalled = false;

/**
 * Idempotently install the global `before_llm_call` flush hook. Safe to
 * call from multiple modules / multiple runs — the registration happens
 * exactly once per process. Subsequent runs just register their persister
 * via {@link registerActivePersister}.
 */
export function ensureIncrementalFlushHook(logger: Logger): void {
  if (flushHookInstalled) return;
  flushHookInstalled = true;
  getHookRegistry().register("before_llm_call", (event) => {
    const persister = activePersisters.get(event.taskId);
    if (persister) {
      try {
        persister.flush();
      } catch (err) {
        logger.error(
          { err, runId: event.taskId },
          "incremental persist flush failed",
        );
      }
    }
    return event;
  });
}

export function registerActivePersister(runId: string, persister: RunPersister): void {
  activePersisters.set(runId, persister);
}

export function unregisterActivePersister(runId: string): void {
  activePersisters.delete(runId);
}
