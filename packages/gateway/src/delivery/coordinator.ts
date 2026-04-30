import { randomUUID } from "node:crypto";
import { getHookRegistry } from "@squad/runner";
import type { Session } from "@squad/runner";
import type { ContentBlock } from "@squad/protocol";
import type { Logger } from "../logger.js";
import type { SessionStore } from "../db/sessions.js";
import { DeliveryQueue, renderDrainAsUserBlock, type QueuedMessage } from "./queue.js";

export interface ActiveRun {
  runId: string;
  session: Session;
  sessionId: string;
}

export interface EnqueueDecision {
  status: "running" | "queued";
  /** For queued, the active run; for running, the caller's chosen new runId. */
  runId: string;
  queuePosition?: number;
}

/**
 * Owns per-session coordination: which run is active, which messages are
 * queued, how queued messages get delivered based on the session's mode.
 *
 * Two delivery modes, one knob, one source of truth:
 *   - interrupt: drained mid-run via a before_llm_call hook.
 *   - queue:     drained after_agent_end, one at a time, each as its own turn.
 *
 * Subagent runs (parent_session_id != null) intentionally bypass the
 * coordinator — the pool already serializes them.
 */
export class RunCoordinator {
  private readonly active: Map<string, ActiveRun> = new Map();
  /**
   * Callback wired by chat dispatch: how to start the next queued turn.
   * Set via `setStarter` so coordinator can be constructed before dispatch
   * is registered.
   */
  private starter:
    | ((sessionId: string, content: ContentBlock[], opts: { persistUserMessage: boolean }) => Promise<void>)
    | null = null;
  private readonly queue: DeliveryQueue;
  private readonly sessions: SessionStore;
  private readonly logger: Logger;
  /** Tracks one drain per run so we don't double-inject across turns. */
  private readonly injectedForRun: Set<string> = new Set();

  constructor(opts: {
    queue: DeliveryQueue;
    sessions: SessionStore;
    logger: Logger;
  }) {
    this.queue = opts.queue;
    this.sessions = opts.sessions;
    this.logger = opts.logger;

    // Register the global before_llm_call hook that drives interrupt mode.
    // The hook fires for every agent run — we scope it to sessions we know
    // are active in this coordinator.
    getHookRegistry().register("before_llm_call", (event) => {
      const { agentType, taskId } = event;
      void agentType;
      const active = this.active.get(taskId);
      if (!active) return event;
      const session = this.sessions.tryGet(active.sessionId);
      if (!session || session.deliveryMode !== "interrupt") return event;
      if (this.injectedForRun.has(active.runId)) {
        // Only inject once per "gap" — allow the LLM to actually respond to
        // the injection before queueing another round.
        return event;
      }
      const drained = this.queue.drainAll(active.sessionId);
      if (drained.length === 0) return event;
      this.injectedForRun.add(active.runId);
      const rendered = renderDrainAsUserBlock(drained);
      active.session._ref().push({ role: "user", content: rendered });
      this.logger.info(
        { sessionId: active.sessionId, count: drained.length, runId: active.runId },
        "interrupted: injected queued messages",
      );
      return event;
    });
  }

  setStarter(
    starter: (
      sessionId: string,
      content: ContentBlock[],
      opts: { persistUserMessage: boolean },
    ) => Promise<void>,
  ): void {
    this.starter = starter;
  }

  /** Called by runChatTurn when a run begins. */
  register(runId: string, sessionId: string, session: Session): void {
    this.active.set(runId, { runId, sessionId, session });
  }

  /** Called by runChatTurn when a run completes (success or failure). */
  async finish(runId: string, sessionId: string): Promise<void> {
    this.active.delete(runId);
    this.injectedForRun.delete(runId);
    // Queue mode: pop one pending message and fire the next turn.
    const session = this.sessions.tryGet(sessionId);
    if (!session) return;
    if (!this.starter) return;
    const starter = this.starter;
    if (session.deliveryMode === "queue") {
      const next = this.queue.drainOne(sessionId);
      if (next) {
        this.logger.info({ sessionId, queuedId: next.id }, "draining queued message");
        // The user message row was already persisted at chat.send time when we
        // enqueued — don't double-insert.
        void starter(sessionId, next.content, { persistUserMessage: false }).catch((err) => {
          this.logger.error({ err, sessionId }, "queued run failed");
        });
      }
    } else if (session.deliveryMode === "interrupt") {
      // In interrupt mode, anything still queued at the end of a run means
      // it arrived after the last before_llm_call. Fire one turn with the
      // drain so we don't strand the user. Same no-double-persist rule.
      const leftovers = this.queue.drainAll(sessionId);
      if (leftovers.length > 0) {
        const rendered = renderDrainAsUserBlock(leftovers);
        void starter(
          sessionId,
          [{ type: "text", text: rendered }],
          { persistUserMessage: false },
        ).catch((err) => {
          this.logger.error({ err, sessionId }, "leftover-drain run failed");
        });
      }
    }
  }

  /**
   * Trigger a fresh chat turn from outside chat dispatch — used by the
   * subagent pool to wake the parent session up when a backgrounded child
   * finishes. The injected user message is persisted by `runChatTurn`
   * itself (persistUserMessage: true). When a run is already active for the
   * session we enqueue instead, mirroring `decide`.
   */
  async startSyntheticTurn(sessionId: string, content: ContentBlock[]): Promise<void> {
    if (!this.starter) {
      this.logger.warn(
        { sessionId },
        "startSyntheticTurn called before starter was wired — dropping",
      );
      return;
    }
    const active = this.findActiveForSession(sessionId);
    if (active) {
      this.queue.enqueue({
        id: randomUUID(),
        sessionId,
        content,
        enqueuedAt: Date.now(),
      });
      this.injectedForRun.delete(active.runId);
      return;
    }
    await this.starter(sessionId, content, { persistUserMessage: true });
  }

  /**
   * Decide whether a new chat.send should start a fresh run or queue behind
   * an active one. Pure decision logic — the caller persists the user
   * message and (if running) fires startTurn.
   */
  decide(sessionId: string, userContent: ContentBlock[], proposedRunId: string): EnqueueDecision {
    const activeForSession = this.findActiveForSession(sessionId);
    if (!activeForSession) {
      return { status: "running", runId: proposedRunId };
    }
    const enqueue = this.queue.enqueue({
      id: randomUUID(),
      sessionId,
      content: userContent,
      enqueuedAt: Date.now(),
    });
    // Give interrupt mode a fresh chance to inject at the next turn.
    this.injectedForRun.delete(activeForSession.runId);
    return {
      status: "queued",
      runId: activeForSession.runId,
      queuePosition: enqueue.position,
    };
  }

  private findActiveForSession(sessionId: string): ActiveRun | null {
    for (const run of this.active.values()) {
      if (run.sessionId === sessionId) return run;
    }
    return null;
  }
}

/** Exported for tests. */
export type { QueuedMessage };
