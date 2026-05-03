import type { HookRegistry } from "@squad/runner";
import type { ApprovalPolicy } from "@squad/plugin-sdk";
import type { ToolRegistry } from "@squad/tools";
import type { ApprovalStore } from "./store.js";
import type { SessionStore } from "../db/sessions.js";
import type { Logger } from "../logger.js";

export interface ApprovalHookDeps {
  hooks: HookRegistry;
  approvals: ApprovalStore;
  policy: ApprovalPolicy;
  toolRegistry: ToolRegistry;
  sessions: SessionStore;
  logger: Logger;
  /** Hard cap on the size of `input` carried to the approval prompt. */
  inputCap?: number;
}

const DEFAULT_INPUT_CAP = 4096;

/**
 * Wire the approval policy into the runner's `before_tool_call` hook.
 *
 * - `allow`    → tool runs.
 * - `deny`     → returning null aborts the tool call; the runner reports a
 *                policy denial back to the LLM as a tool error.
 * - `escalate` → raise an approval; pause until the dashboard / Discord /
 *                CLI lands a decision via `approvals.respond` (alias of the
 *                existing `approvals.decide` method).
 */
export function installApprovalHook(deps: ApprovalHookDeps): () => void {
  const cap = deps.inputCap ?? DEFAULT_INPUT_CAP;

  deps.hooks.register("before_tool_call", async (event) => {
    const data = event.data as {
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolUseId?: string;
    };
    const toolName = data.toolName;
    if (!toolName) return event;
    const toolInput = data.toolInput ?? {};
    const toolUseId = data.toolUseId ?? "";

    // Pull tags off the registered tool so the policy gets the right context.
    const tool = deps.toolRegistry.get(toolName);
    const tags = (tool?.tags ?? []) as string[];

    const sessionId = (event.data["sessionId"] as string | undefined) ?? event.taskId;
    const session = sessionId ? deps.sessions.tryGet(sessionId) : null;
    const parentSessionId = session?.parentSessionId ?? null;
    // For approval routing we always want the root session — that's where the
    // user's UI is watching. Subagent tool calls would otherwise raise on the
    // subagent's sessionId, which no human is subscribed to, and block forever.
    const rootSessionId = sessionId
      ? (() => {
          try {
            return deps.sessions.rootId(sessionId);
          } catch (err) {
            deps.logger.warn(
              { err, sessionId, toolName },
              "approvals: rootId lookup failed — using current sessionId",
            );
            return sessionId;
          }
        })()
      : null;

    const verdict = await deps.policy.decide({
      sessionId: sessionId ?? "",
      parentSessionId,
      toolName,
      tags,
      input: toolInput,
    });

    if (verdict === "approve") return event;
    if (verdict === "deny") {
      deps.logger.warn(
        { toolName, sessionId, tags },
        "tool call denied by approval policy",
      );
      return null;
    }

    // Escalate: raise an approval prompt and block until decided.
    if (!sessionId) {
      // No session context — fail closed rather than auto-approving an
      // escalated call we can't trace back to a user.
      deps.logger.error({ toolName }, "approval requested but no sessionId in hook context");
      return null;
    }
    const trimmedInput = capInputSize(toolInput, cap);
    // Raise the approval against the root session so the user's UI sees it
    // even when the calling tool lives inside a subagent.
    const approvalSessionId = rootSessionId ?? sessionId;
    const { approval, settled } = deps.approvals.raise({
      sessionId: approvalSessionId,
      toolCallId: toolUseId,
      toolName,
      input: trimmedInput,
      tags,
    });
    deps.logger.info(
      {
        approvalId: approval.id,
        toolName,
        sessionId,
        rootSessionId: approvalSessionId,
        viaSubagent: approvalSessionId !== sessionId,
        tags,
      },
      "approval requested — awaiting decision",
    );
    const decided = await settled;
    if (decided.decision === "approve") return event;
    deps.logger.warn(
      { approvalId: approval.id, toolName, sessionId, decision: decided.decision },
      "approval denied — aborting tool call",
    );
    return null;
  });

  // Best-effort cleanup — no per-handler unregister in HookRegistry today.
  return () => {
    /* HookRegistry only clears all handlers; let the global registry persist. */
  };
}

function capInputSize(input: unknown, cap: number): unknown {
  try {
    const json = JSON.stringify(input);
    if (json.length <= cap) return input;
    return { __truncated: true, preview: json.slice(0, cap), originalSize: json.length };
  } catch {
    return { __unserialisable: true };
  }
}
