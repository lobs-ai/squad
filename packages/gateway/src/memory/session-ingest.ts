/**
 * SessionIngestionService — incremental, idle-driven memory ingestion.
 *
 * Sessions in squad rarely "end". Users go quiet, sometimes for hours, and
 * then come back to the same conversation. Waiting for an explicit `end`
 * signal would mean either never ingesting or ingesting too late. Instead we
 * watermark each session and re-ingest the unprocessed delta whenever the
 * session has been idle long enough.
 *
 * Lifecycle per session:
 *   1. Sweeper picks sessions where (last activity > idle_threshold) AND
 *      (last_message_id > watermark). Tiny deltas are skipped unless the
 *      session is older than max_idle (force-ingest).
 *   2. Status flips idle → queued → in_progress.
 *   3. Service renders messages [watermark, latest] as a transcript and
 *      calls memcore.add({ extract: true }).
 *   4. On success: advance watermark, invalidate the eager cache so the
 *      next turn picks up fresh memories, drop status back to idle.
 *   5. On failure: increment attempts, record last_error, drop back to idle
 *      so the next sweep can retry. After a hard cap, mark failed.
 *
 * Crash recovery happens at gateway boot via SessionStore.resetInFlightIngest()
 * — anything `queued`/`in_progress` becomes `idle` again.
 */

import type { Logger } from "pino";
import type { MemCore } from "memcore";
import type { MessageStore } from "../db/messages.js";
import type { SessionStore } from "../db/sessions.js";
import type { MemoryService } from "./service.js";
import type { ContentBlock, MessageRecord } from "@squad/protocol";

export interface IngestConfig {
  idleThresholdSeconds: number;
  maxIdleSeconds: number;
  minDeltaMessages: number;
  minDeltaTokens: number;
  includeSubagents: boolean;
  sweeperIntervalSeconds: number;
}

export interface SessionIngestionDeps {
  memcore: MemCore;
  sessions: SessionStore;
  messages: MessageStore;
  memoryService: MemoryService;
  logger: Logger;
  containerTag: string;
  config: IngestConfig;
}

const MAX_ATTEMPTS = 5;
const ROUGH_CHARS_PER_TOKEN = 4;

export class SessionIngestionService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SessionIngestionDeps) {}

  /**
   * Start the periodic sweeper. Idempotent. The first tick fires after
   * `sweeperIntervalSeconds` so boot stays cheap; call `tick()` directly
   * if you want immediate work (tests do this).
   */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const intervalMs = this.deps.config.sweeperIntervalSeconds * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // Don't keep the event loop alive just to sweep — the gateway's HTTP
    // listener is what should pin the process.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Wait for an in-flight tick to drain so callers (test teardown) see a
    // quiescent state.
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }

  /**
   * One pass of the sweeper. Picks idle sessions, enqueues + processes the
   * eligible ones inline. Public so tests / admin tools can force a pass.
   * Concurrent calls coalesce — only one tick runs at a time.
   */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const candidates = this.deps.sessions.listIdleForIngest({
        idleSeconds: this.deps.config.idleThresholdSeconds,
        limit: 25,
      });
      for (const c of candidates) {
        if (this.stopped) break;
        await this.tryIngest(c.sessionId, "sweeper");
      }
    } catch (err) {
      this.deps.logger.error({ err }, "session ingestion sweeper failed");
    } finally {
      this.running = false;
    }
  }

  /**
   * Run a single ingestion job for `sessionId`. Used by the session.end
   * handler and admin tools when the caller wants immediate processing
   * rather than waiting for the next sweep.
   */
  async ingestNow(sessionId: string): Promise<IngestOutcome> {
    return this.tryIngest(sessionId, "manual");
  }

  private async tryIngest(
    sessionId: string,
    trigger: "sweeper" | "manual",
  ): Promise<IngestOutcome> {
    const state = this.deps.sessions.getIngestState(sessionId);
    if (!state.ingestable) return { status: "skipped", reason: "not_ingestable" };
    if (state.status === "queued" || state.status === "in_progress") {
      return { status: "skipped", reason: "in_flight" };
    }
    if (state.status === "failed") {
      // Failed sessions need explicit re-trigger. Sweeper skips them so a
      // bad session doesn't burn LLM calls every minute.
      if (trigger === "sweeper") return { status: "skipped", reason: "failed" };
    }

    // Pull unprocessed messages.
    const allMessages = this.deps.messages
      .listForSession(sessionId, 5000)
      .filter((m) => m.role !== "system");
    const delta = sliceDelta(allMessages, state.watermarkMessageId);
    if (delta.length === 0) return { status: "skipped", reason: "no_delta" };

    // Min-delta gates, with an escape hatch for old idle sessions so content
    // doesn't leak forever.
    const ageSeconds = (Date.now() - new Date(state.updatedAt).getTime()) / 1000;
    const force = ageSeconds >= this.deps.config.maxIdleSeconds;
    if (!force && trigger === "sweeper") {
      const tokenEstimate = estimateTokens(delta);
      if (
        delta.length < this.deps.config.minDeltaMessages &&
        tokenEstimate < this.deps.config.minDeltaTokens
      ) {
        return { status: "skipped", reason: "delta_too_small" };
      }
    }

    this.deps.sessions.setIngestStatus(sessionId, "in_progress");
    const transcript = renderTranscript(delta);
    const lastMessage = delta[delta.length - 1]!;
    try {
      const result = await this.deps.memcore.add({
        containerTag: this.deps.containerTag,
        content: transcript,
        externalId: `session:${sessionId}:chunk:${state.chunksProcessed + 1}`,
        sourceType: "squad-session",
        metadata: {
          provenanceSessionId: sessionId,
          ingestChunkIndex: state.chunksProcessed + 1,
          messageCount: delta.length,
          firstMessageId: delta[0]!.id,
          lastMessageId: lastMessage.id,
          trigger,
        },
        documentDate: new Date(lastMessage.createdAt),
        extract: true,
      });
      this.deps.sessions.recordIngestSuccess(sessionId, lastMessage.id);
      this.deps.memoryService.invalidateSession(sessionId);
      this.deps.logger.info(
        {
          sessionId,
          chunkIndex: state.chunksProcessed + 1,
          messageCount: delta.length,
          memoriesWritten: result.memoriesWritten,
          chunksWritten: result.chunksWritten,
          duplicatesSkipped: result.duplicatesSkipped,
          trigger,
        },
        "session ingestion completed",
      );
      return { status: "ingested", chunkIndex: state.chunksProcessed + 1 };
    } catch (err) {
      const attempts = state.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      const terminal = attempts >= MAX_ATTEMPTS;
      this.deps.sessions.setIngestStatus(sessionId, terminal ? "failed" : "idle", {
        attempts,
        lastError: message,
      });
      this.deps.logger.error(
        { sessionId, attempts, terminal, err },
        "session ingestion failed",
      );
      return { status: "failed", attempts, terminal };
    }
  }
}

export type IngestOutcome =
  | { status: "ingested"; chunkIndex: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; attempts: number; terminal: boolean };

/**
 * Return messages strictly after `watermarkMessageId`. The caller passes
 * messages in chronological order. Watermark of `null` means "ingest from
 * the beginning."
 */
function sliceDelta(
  messages: MessageRecord[],
  watermarkMessageId: string | null,
): MessageRecord[] {
  if (!watermarkMessageId) return messages;
  const idx = messages.findIndex((m) => m.id === watermarkMessageId);
  if (idx < 0) return messages;
  return messages.slice(idx + 1);
}

function renderTranscript(messages: MessageRecord[]): string {
  return messages
    .map((m) => {
      const role = m.role === "tool" ? "Tool" : capitalize(m.role);
      const body = renderContent(m.content);
      return body ? `${role}: ${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderContent(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_use") parts.push(`[tool: ${b.name}]`);
    else if (b.type === "tool_result") {
      // Drop tool_result payloads from the transcript — they're typically large
      // (file contents, search hits) and noisy for extraction. The fact that a
      // tool ran is captured by the tool_use block above; the *interesting*
      // signal lives in the assistant's next text turn.
      continue;
    }
  }
  return parts.join(" ").trim();
}

function estimateTokens(messages: MessageRecord[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
    }
  }
  return Math.ceil(chars / ROUGH_CHARS_PER_TOKEN);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
