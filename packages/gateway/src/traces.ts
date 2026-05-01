import type { Broadcast } from "./broadcast.js";
import type { Logger } from "./logger.js";
import type { HookRegistry } from "@squad/runner";

/**
 * Bidirectional registry: callers register a runId → sessionId mapping at
 * run-start so the hook can publish trace events scoped to the right session.
 * The gateway's `runChatTurn` and the SubagentPool call register/unregister
 * around each agent run.
 */
export class TraceSessionRegistry {
  private readonly map = new Map<string, string>();
  register(runId: string, sessionId: string): void {
    this.map.set(runId, sessionId);
  }
  unregister(runId: string): void {
    this.map.delete(runId);
  }
  get(runId: string): string | null {
    return this.map.get(runId) ?? null;
  }
}

/**
 * Per-run step counters. The runner doesn't expose a turn number to hooks
 * directly — we keep one here keyed on `taskId` (which the gateway uses as
 * `runId`). Cleared after `after_agent_end`.
 */
type RunState = {
  step: number;
  cumulativeIn: number;
  cumulativeOut: number;
  cumulativeCost: number;
  startedAt: number;
  /** Wall-clock instant the most recent before_llm_call fired. */
  llmStartedAt: number | null;
};

/**
 * Wire after_llm_call → broadcast `trace.step/<sessionId>`. Each step carries
 * usage, model, duration, tool-call summary, and cumulative totals so dashboard
 * subscribers can render a flame graph or running-cost meter without holding
 * state themselves.
 */
export function installTraceHook(
  hooks: HookRegistry,
  broadcast: Broadcast,
  sessionRegistry: TraceSessionRegistry,
  logger: Logger,
): void {
  const states = new Map<string, RunState>();

  hooks.register("before_agent_start", async (event) => {
    states.set(event.taskId, {
      step: 0,
      cumulativeIn: 0,
      cumulativeOut: 0,
      cumulativeCost: 0,
      startedAt: Date.now(),
      llmStartedAt: null,
    });
    return event;
  });

  hooks.register("before_llm_call", async (event) => {
    const s = states.get(event.taskId);
    if (s) s.llmStartedAt = Date.now();
    return event;
  });

  hooks.register("after_llm_call", async (event) => {
    const state = states.get(event.taskId);
    if (!state) return event;
    state.step++;
    const data = event.data as {
      response?: {
        content?: Array<Record<string, unknown>>;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
      model?: string;
      usage?: { inputTokens: number; outputTokens: number };
      costUsd?: number;
    };
    const response = data.response;
    if (!response) return event;
    const usage = response.usage ?? { inputTokens: 0, outputTokens: 0 };
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    const cumulative = data.usage ?? { inputTokens: 0, outputTokens: 0 };
    state.cumulativeIn = cumulative.inputTokens;
    state.cumulativeOut = cumulative.outputTokens;
    state.cumulativeCost = data.costUsd ?? state.cumulativeCost;

    const toolCalls: Array<{ id: string; name: string }> = [];
    for (const block of response.content ?? []) {
      if ((block as { type?: string }).type === "tool_use") {
        const tu = block as { id?: string; name?: string };
        toolCalls.push({ id: tu.id ?? "", name: tu.name ?? "" });
      }
    }

    const denominator = usage.inputTokens || 1;
    const cacheHitRatio = Math.min(1, cacheRead / denominator);

    const sessionId = sessionRegistry.get(event.taskId);
    const now = Date.now();
    const durationMs = state.llmStartedAt ? now - state.llmStartedAt : 0;
    state.llmStartedAt = null;

    const payload = {
      sessionId: sessionId ?? "unknown",
      runId: event.taskId,
      step: state.step,
      model: data.model ?? "",
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cumulative: {
        inputTokens: state.cumulativeIn,
        outputTokens: state.cumulativeOut,
        costUsd: state.cumulativeCost,
      },
      toolCalls,
      cacheHitRatio,
      occurredAt: new Date(now).toISOString(),
    };

    if (sessionId) {
      broadcast.publish(`trace.step/${sessionId}`, payload);
    } else {
      logger.debug({ runId: event.taskId }, "trace.step skipped — no session id resolvable");
    }
    return event;
  });

  hooks.register("after_agent_end", async (event) => {
    states.delete(event.taskId);
    return event;
  });
}

