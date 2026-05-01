/**
 * Boot-time recovery for chat runs that were in flight when the previous
 * gateway process exited.
 *
 * The crash window:
 *   `runs.ts` flushes the transcript at every `before_llm_call` boundary,
 *   so the worst-case loss is one in-flight LLM turn — its assistant
 *   message (which may carry tool_use blocks) plus the matching
 *   tool_result message. If the crash happened *between* flushes, we end
 *   up with one of two transcript shapes:
 *
 *     1) Last persisted message is `assistant` with one or more
 *        `tool_use` blocks. The tool batch never executed (or executed
 *        but its `tool` row was lost). Anthropic rejects history that
 *        has unmatched `tool_use` blocks, so we fabricate a `tool`
 *        message with synthetic error `tool_result` blocks and persist
 *        it. The next turn the agent will see "those tool calls failed"
 *        and decide what to do.
 *
 *     2) Last persisted message is `user` (the original send) or `tool`
 *        (a clean batch). Either is a valid resume point — we just
 *        re-fire a turn so the agent picks up where it left off.
 *
 * For each running session we then:
 *   - Reset `status` from `running` → `idle` so chat.send doesn't think
 *     a turn is still active.
 *   - Mark any `pending` tool_calls rows as `failed` (their assistant
 *     message either was repaired with synthetic results or was never
 *     persisted in the first place; the rows are orphans either way).
 *   - Broadcast `session.resumed` so dashboards can render a banner.
 *   - Fire a fresh turn via `coordinator.deliverExternalMessage` with
 *     no new user content (`persistUserMessage: false`) so the agent
 *     continues from the repaired history.
 */

import type { ContentBlock, MessageRecord } from "@squad/protocol";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { RunCoordinator } from "../delivery/coordinator.js";
import type { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";
import type { DatabaseHandle } from "../db/index.js";

export interface RecoveryDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  coordinator: RunCoordinator;
  broadcast: Broadcast;
  logger: Logger;
  db: DatabaseHandle;
}

export interface RecoveryResult {
  /** Number of sessions found in `running` at boot. */
  candidates: number;
  /** Sessions that were repaired and a fresh turn was fired for. */
  resumed: number;
  /** Sessions that were already complete (last assistant message had no
   *  unanswered tool_use blocks) — just reset to `idle`. */
  noResumeNeeded: number;
  /** Sessions that couldn't be resumed (e.g. coordinator missing, no
   *  history at all). Reset to `idle` and skipped. */
  skipped: number;
  /** Number of orphan `pending` tool_calls rows marked failed. */
  orphanToolCalls: number;
}

/**
 * Sweep all sessions left in `running` from a previous process. Idempotent —
 * safe to call multiple times; sessions already moved to `idle` are simply
 * not picked up.
 */
export async function recoverInFlightRuns(deps: RecoveryDeps): Promise<RecoveryResult> {
  const ids = deps.sessions.listRunningSessionIds();
  const result: RecoveryResult = {
    candidates: ids.length,
    resumed: 0,
    noResumeNeeded: 0,
    skipped: 0,
    orphanToolCalls: 0,
  };

  if (ids.length === 0) return result;

  result.orphanToolCalls = markPendingToolCallsFailed(deps.db);

  for (const sessionId of ids) {
    try {
      const outcome = await recoverOne(sessionId, deps);
      if (outcome === "resumed") result.resumed++;
      else if (outcome === "complete") result.noResumeNeeded++;
      else result.skipped++;
    } catch (err) {
      deps.logger.error({ err, sessionId }, "session recovery failed — leaving idle");
      try {
        deps.sessions.setStatus(sessionId, "idle");
      } catch {
        // ignore — best effort
      }
      result.skipped++;
    }
  }

  deps.logger.info(
    {
      candidates: result.candidates,
      resumed: result.resumed,
      noResumeNeeded: result.noResumeNeeded,
      skipped: result.skipped,
      orphanToolCalls: result.orphanToolCalls,
    },
    "in-flight chat run recovery complete",
  );

  return result;
}

type RecoveryOutcome = "resumed" | "complete" | "skipped";

async function recoverOne(
  sessionId: string,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  const session = deps.sessions.tryGet(sessionId);
  if (!session) return "skipped";

  // Subagent recovery is harder (the parent's run carries the result back
  // via setBackgroundOutcomeHandler) and far less common — we just clean
  // up state for now. The next user message to the parent will still be
  // delivered correctly.
  if (session.parentSessionId) {
    deps.sessions.setStatus(sessionId, "idle");
    return "skipped";
  }

  const history = deps.messages.listForSession(sessionId, 1000);
  const repair = repairTrailingToolUse(sessionId, history, deps.messages);
  const repaired = repair.repaired ? deps.messages.listForSession(sessionId, 1000) : history;

  // If the last message is an assistant message with no unanswered
  // tool_use blocks, the previous run actually finished its final turn —
  // we just lost the status flip. Mark idle and stop.
  const last = repaired[repaired.length - 1];
  if (!last) {
    deps.sessions.setStatus(sessionId, "idle");
    return "skipped";
  }

  if (last.role === "assistant") {
    const hasToolUse = last.content.some((b) => b.type === "tool_use");
    if (!hasToolUse) {
      deps.sessions.setStatus(sessionId, "idle");
      deps.broadcast.publish(`session.resumed/${sessionId}`, {
        sessionId,
        kind: "complete",
        repairedToolUses: repair.synthesizedToolResults,
      });
      return "complete";
    }
    // Defensive: we already repaired, so an assistant-with-tool_use here
    // means the repair didn't fire (no unmatched ids, all already paired).
    // That's effectively the same shape as a tool/user-trailing turn —
    // re-fire so the agent makes progress.
  }

  // Reset status BEFORE delivering — the coordinator's decide() looks at
  // active runs (in memory), not session.status, but other readers (dashboards)
  // do read status, so flipping it now keeps the UI consistent.
  deps.sessions.setStatus(sessionId, "idle");

  deps.broadcast.publish(`session.resumed/${sessionId}`, {
    sessionId,
    kind: "resumed",
    repairedToolUses: repair.synthesizedToolResults,
  });

  // Fire a fresh turn with no new user content. The coordinator's
  // deliverExternalMessage path was built for backgrounded subagent
  // wakes, but it's the right shape here too: persistUserMessage=false,
  // and if there's no active run it starts a new one immediately.
  await deps.coordinator.deliverExternalMessage(sessionId, []);
  return "resumed";
}

/**
 * If the last persisted message is `assistant` with `tool_use` blocks
 * that have no matching `tool_result` in the next message, fabricate a
 * `tool` message with synthetic error tool_results so the LLM can be
 * called again. Returns `{ repaired, synthesizedToolResults }`.
 */
export function repairTrailingToolUse(
  sessionId: string,
  history: MessageRecord[],
  messages: MessageStore,
): { repaired: boolean; synthesizedToolResults: number } {
  if (history.length === 0) return { repaired: false, synthesizedToolResults: 0 };
  const last = history[history.length - 1]!;
  if (last.role !== "assistant") return { repaired: false, synthesizedToolResults: 0 };

  const toolUseIds = last.content
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => b.id);
  if (toolUseIds.length === 0) return { repaired: false, synthesizedToolResults: 0 };

  // The runner appends tool_results as the *next* message after the
  // assistant turn. If that next message exists and covers every id, we
  // don't need to do anything. Since `last` is at the end, by definition
  // there's no next message.
  const synthetic: ContentBlock[] = toolUseIds.map((id) => ({
    type: "tool_result" as const,
    toolUseId: id,
    content: "Tool execution interrupted by gateway restart.",
    isError: true,
  }));

  messages.append({
    sessionId,
    role: "tool",
    content: synthetic,
  });

  return { repaired: true, synthesizedToolResults: synthetic.length };
}

/**
 * Anything in `pending` from a previous process is an orphan — its run
 * is gone. Mark them failed so analytics / doctor checks don't think
 * they're still in flight.
 */
function markPendingToolCallsFailed(db: DatabaseHandle): number {
  const result = db
    .prepare(
      `UPDATE tool_calls
          SET status = 'failed',
              is_error = 1,
              result_json = ?
        WHERE status = 'pending'`,
    )
    .run(JSON.stringify("Tool execution interrupted by gateway restart."));
  return result.changes;
}
