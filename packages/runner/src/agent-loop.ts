// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/agent-loop.ts
// Last synced: 2026-04-23
// Squad local edits:
//  - sticky-per-session model chain (see "Squad local edit" below)
//  - before_tool_call hook receives `sessionId` / `parentSessionId` from
//    spec.context so policy hooks can scope decisions (added 2026-04-30).

/**
 * Agent loop — the core LLM ↔ tool execution cycle.
 *
 * Multi-provider: Anthropic (native), OpenAI, any OpenAI-compatible endpoint.
 * Uses the @agentic/llm provider abstraction to normalise all responses.
 *
 * Loop:
 * 1. Build system prompt
 * 2. Call LLM with current messages + tool definitions
 * 3. stop_reason == "end_turn" / "stop" → done
 * 4. stop_reason == "tool_use" → execute tools → append results → goto 2
 * 5. maxTurns exceeded or timeout → forced stop
 */

import { randomBytes } from "node:crypto";
// Squad local edit: Squad uses a sticky-per-session model chain rather than
// the lobs-core resilient-client / circuit-breaker / key-manager stack. The
// chain tries the primary first and advances on fallback-eligible errors
// (rate limit / 5xx / timeout / network). Once it advances it stays there
// for the rest of the run — no probe-back-to-primary per turn.
import { createClient, createModelChain, parseModelString } from "@squad/llm";
import type { LLMMessage, ContentBlock, ToolUseBlock } from "@squad/llm";
import {
  type AgentSpec,
  type AgentResult,
  type ToolResult,
  type TokenUsage,
  MODEL_COSTS,
  normalizeTimeout,
} from "./types.js";
import { getToolDefinitions, executeTool } from "./tool-registry.js";
import { getHookRegistry } from "./hooks.js";
import { LoopDetector } from "./loop-detector.js";
import { estimateTokens } from "./context-manager.js";
import { defaultContextEngine, type ContextEngine } from "./context-engine.js";
import { Session } from "./session.js";
import { SessionTranscript } from "./session-transcript.js";

export type { AgentSpec, AgentResult };

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_TOKENS = 16384;
const TRANSIENT_ERRORS = ["overloaded", "529", "timeout", "network", "ECONNRESET"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPostToolReminder(cwd: string, results: ToolResult[]): string {
  const succeeded = results.filter((r) => !r.is_error).length;
  const failed = results.length - succeeded;
  return [
    "You have fresh tool results.",
    `Working directory: ${cwd}`,
    `Tool calls this round: ${results.length} total, ${succeeded} succeeded, ${failed} failed.`,
    "Use these results to decide the next concrete step.",
    "If the latest tool results already solve the user's request, respond and stop.",
    "If you changed files, prefer a targeted verification step before concluding.",
    "If the task is complete, stop instead of making extra tool calls.",
    "If more work is needed, prefer the smallest next read/search/edit/exec action that reduces uncertainty.",
  ].join("\n");
}

function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_ERRORS.some((e) => lower.includes(e));
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

/**
 * Run an agent through the LLM tool loop until completion, timeout, or
 * max turns.
 */
export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
  const { task, agent, model } = spec;
  const timeoutCfg = normalizeTimeout(spec.timeout);
  let cwd = spec.cwd;
  const maxTurns = spec.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxTokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS;
  const contextEngine: ContextEngine = spec.contextEngine ?? defaultContextEngine;
  const registry = spec.toolRegistry;

  // ── IDs ───────────────────────────────────────────────────────────────────
  const runId = randomBytes(8).toString("hex");
  const taskId = spec.context?.taskId ?? runId;
  const startTime = Date.now();

  // ── Transcript ────────────────────────────────────────────────────────────
  let transcript: SessionTranscript | null = null;
  try {
    transcript = new SessionTranscript(agent, runId);
  } catch {
    // Transcript is best-effort — FS may not be available in all environments
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────
  const hooks = getHookRegistry();

  // ── Provider ──────────────────────────────────────────────────────────────
  // `model` is the primary; `spec.fallbacks` extends the chain. Sticky: once
  // a fallback takes over, every subsequent turn reuses that model.
  const parsed = parseModelString(model);
  const fallbacks = spec.fallbacks ?? [];
  const llm =
    spec.clientOverride ??
    (fallbacks.length > 0
      ? createModelChain({ primary: model, fallbacks })
      : createClient(model));

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt =
    spec.systemPrompt ??
    buildDefaultSystemPrompt(agent, spec.context?.notes);

  // ── Session / message history ─────────────────────────────────────────────
  // Use spec.session if provided so the application can observe messages live.
  // Fall back to a private Session seeded from initialMessages.
  const session =
    spec.session ??
    new Session(spec.initialMessages ?? [{ role: "user", content: task }]);
  const messages = session._ref();
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let totalCost = 0;
  let turns = 0;
  const loopDetector = new LoopDetector();

  // ── beforeAgentStart hook ─────────────────────────────────────────────────
  await hooks.emit("before_agent_start", {
    agentType: agent,
    taskId,
    data: { task, model, cwd, tools: spec.tools },
    timestamp: new Date(),
  });

  // ── Timeout guards ────────────────────────────────────────────────────────
  // A run ends when any active timer fires. `timedOutKind` records which one.
  let timedOut = false;
  let timedOutKind: "total" | "perTurn" | "perLlmCall" | null = null;
  const totalMs = (timeoutCfg.total ?? 300) * 1000;
  const totalHandle = setTimeout(() => {
    if (!timedOut) {
      timedOut = true;
      timedOutKind = "total";
    }
  }, totalMs);
  const activeHandles: NodeJS.Timeout[] = [totalHandle];
  const markTimedOut = (kind: "perTurn" | "perLlmCall"): void => {
    if (!timedOut) {
      timedOut = true;
      timedOutKind = kind;
    }
  };

  const finish = (
    succeeded: boolean,
    output: string,
    stopReason: string,
    error?: string,
  ): AgentResult => {
    transcript?.writeComplete(runId, agent, succeeded, turns, totalUsage, stopReason, error);
    return {
      succeeded,
      output,
      error,
      usage: totalUsage,
      costUsd: totalCost,
      turns,
      runId,
    };
  };

  try {
    // ── Main loop ─────────────────────────────────────────────────────────
    while (turns < maxTurns && !timedOut) {
      turns++;

      // ── Per-turn timer ──────────────────────────────────────────────────
      // Starts fresh at the top of each LLM turn. When set, bounds the
      // think-plus-tool-execution block so a single pathological turn can't
      // blow the whole run; the `total` timer is still authoritative.
      let turnHandle: NodeJS.Timeout | null = null;
      if (timeoutCfg.perTurn && timeoutCfg.perTurn > 0) {
        turnHandle = setTimeout(
          () => markTimedOut("perTurn"),
          timeoutCfg.perTurn * 1000,
        );
        activeHandles.push(turnHandle);
      }

      // ── Context compaction ──────────────────────────────────────────────
      if (turns > 1 && contextEngine.shouldCompact(messages, model)) {
        const compacted = contextEngine.compact(messages);
        messages.length = 0;
        messages.push(...compacted);

        await hooks.emit("session_compacted", {
          agentType: agent,
          taskId,
          data: { turnCount: turns, messageCount: messages.length },
          timestamp: new Date(),
        });
      }

      // ── Per-turn tool selection ─────────────────────────────────────────
      // Context engine can vary tools each turn (e.g. restrict to read-only
      // after N writes, or enable a "done" tool once a condition is met).
      const activeTools = contextEngine.selectTools && registry
        ? (contextEngine.selectTools(messages, registry) ?? spec.tools)
        : spec.tools;
      const toolDefs = registry
        ? registry.getDefinitions(activeTools)
        : getToolDefinitions(activeTools);

      // Strip runtime-only `tags` — only send the LLM-contract fields
      const toolDefsForLlm = toolDefs.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

      // ── beforeLlmCall hook ──────────────────────────────────────────────
      await hooks.emit("before_llm_call", {
        agentType: agent,
        taskId,
        data: { messages, model, turn: turns },
        timestamp: new Date(),
      });

      // ── LLM call ───────────────────────────────────────────────────────
      let response;
      try {
        const llmParams = {
          system: systemPrompt,
          messages,
          tools: toolDefsForLlm,
          model: parsed.modelId,
          maxTokens,
        };
        const llmPromise =
          spec.onTextChunk && llm.streamMessage
            ? llm.streamMessage(llmParams, spec.onTextChunk)
            : llm.createMessage(llmParams);
        if (timeoutCfg.perLlmCall && timeoutCfg.perLlmCall > 0) {
          const perLlmMs = timeoutCfg.perLlmCall * 1000;
          response = await Promise.race([
            llmPromise,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`LLM call exceeded perLlmCall (${timeoutCfg.perLlmCall}s)`)),
                perLlmMs,
              ),
            ),
          ]);
        } else {
          response = await llmPromise;
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));

        await hooks.emit("on_error", {
          agentType: agent,
          taskId,
          data: { phase: "llm_call", error: error.message, turn: turns },
          timestamp: new Date(),
        });

        if (isTransientError(error.message) && turns < maxTurns) {
          const waitMs = Math.min(2000 * 2 ** Math.min(turns - 1, 5), 60_000);
          await new Promise((r) => setTimeout(r, waitMs));
          turns--; // don't count the retry as a turn
          continue;
        }

        return finish(false, "", "llm_error", error.message);
      }

      // Timeout may have fired while awaiting the LLM call
      if (timedOut) break;

      // ── Usage accounting ────────────────────────────────────────────────
      totalUsage = {
        inputTokens: totalUsage.inputTokens + response.usage.inputTokens,
        outputTokens: totalUsage.outputTokens + response.usage.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };

      const modelId = parsed.modelId;
      const rates = MODEL_COSTS[modelId] ?? { inputPerM: 3.0, outputPerM: 15.0 };
      totalCost +=
        (response.usage.inputTokens / 1_000_000) * rates.inputPerM +
        (response.usage.outputTokens / 1_000_000) * rates.outputPerM;

      // ── afterLlmCall hook ───────────────────────────────────────────────
      await hooks.emit("after_llm_call", {
        agentType: agent,
        taskId,
        data: { response, model, turn: turns, usage: totalUsage, costUsd: totalCost },
        timestamp: new Date(),
      });

      // ── Sanitize & append response ──────────────────────────────────────
      const responseContent = spec.sanitizeResponseContent
        ? spec.sanitizeResponseContent(response.content)
        : response.content;

      messages.push({ role: "assistant", content: responseContent as unknown as Array<Record<string, unknown>> });

      // ── End-turn ────────────────────────────────────────────────────────
      if (
        response.stopReason === "end_turn" ||
        response.stopReason === "stop"
      ) {
        const textBlock = responseContent.find((b: ContentBlock) => b.type === "text");
        const output =
          textBlock?.type === "text" ? (textBlock.text ?? "") : "";

        await hooks.emit("after_agent_end", {
          agentType: agent,
          taskId,
          data: { succeeded: true, output, turns, usage: totalUsage, costUsd: totalCost },
          timestamp: new Date(),
        });

        return finish(true, output, "end_turn");
      }

      // ── Tool calls ───────────────────────────────────────────────────────
      const toolUseBlocks = responseContent.filter((b: ContentBlock): b is ToolUseBlock => b.type === "tool_use");

      if (toolUseBlocks.length === 0) {
        // No text, no tool use → treat as completion
        const textBlock = responseContent.find((b: ContentBlock) => b.type === "text");
        const output =
          textBlock?.type === "text" ? (textBlock.text ?? "") : "";
        return finish(true, output, "no_tool_use");
      }

      // ── Execute tools in parallel ────────────────────────────────────────
      const toolResults: ToolResult[] = [];

      await Promise.all(
        toolUseBlocks.map(async (block: ToolUseBlock) => {
          const toolUseId = block.id ?? "";
          const blockName = block.name ?? "";
          const blockInput = (block.input ?? {}) as Record<string, unknown>;

          // beforeToolCall hook — returning null denies execution.
          // Squad local edit: forward `sessionId` from spec.context so policy
          // hooks (e.g. approval escalation) can scope their decision.
          const beforeEvent = await hooks.emit("before_tool_call", {
            agentType: agent,
            taskId,
            data: {
              toolName: blockName,
              toolInput: blockInput,
              toolUseId,
              ...(spec.context?.sessionId !== undefined
                ? { sessionId: spec.context.sessionId }
                : {}),
              ...(spec.context?.parentTaskId !== undefined
                ? { parentSessionId: spec.context.parentTaskId }
                : {}),
            },
            timestamp: new Date(),
          });

          if (!beforeEvent) {
            toolResults.push({
              toolUseId,
              content: "Tool execution denied by policy.",
              is_error: true,
            });
            return;
          }

          const toolName = String(beforeEvent.data["toolName"] ?? blockName);
          const toolInput = (beforeEvent.data["toolInput"] ?? blockInput) as Record<
            string,
            unknown
          >;

          spec.onProgress?.({
            type: "tool_start",
            agentType: agent,
            toolName,
            toolInput,
            toolUseId,
          });

          // Execute with timeout
          let result: ToolResult;
          try {
            let executePromise: Promise<ToolResult>;

            if (spec.toolExecutor) {
              executePromise = spec.toolExecutor(toolName, toolInput, toolUseId, cwd, {
                channelId: spec.context?.channelId,
                toolUseId,
              });
            } else if (registry) {
              executePromise = registry.execute(toolName, toolInput, cwd, spec.context as Record<string, unknown> | undefined).then((raw) => {
                const content = typeof raw === "string" ? raw : raw.result;
                // Propagate cwd changes from exec tool's sideEffects
                if (typeof raw !== "string" && raw.sideEffects?.newCwd) {
                  cwd = raw.sideEffects.newCwd;
                }
                return { toolUseId, content };
              });
            } else {
              executePromise = executeTool(toolName, toolInput, toolUseId, cwd);
            }

            // perTool: a single tool that runs too long is reported back to
            // the LLM as an error so the agent can try a different approach.
            // It does NOT kill the run — only `total` / `perTurn` / `perLlmCall`
            // are fatal, because those indicate systemic stalls.
            const perToolSec = timeoutCfg.perTool ?? 300;
            result = await Promise.race([
              executePromise,
              new Promise<ToolResult>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Tool execution exceeded perTool (${perToolSec}s)`)),
                  perToolSec * 1000,
                ),
              ),
            ]);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            result = {
              toolUseId,
              content: `Tool error: ${msg}`,
              is_error: true,
            };
          }

          // Loop detection
          const loopResult = loopDetector.record(
            toolName,
            toolInput,
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content),
          );

          if (loopResult.detected) {
            const annotation =
              loopResult.severity === "critical"
                ? `\n\n[LOOP DETECTED: ${loopResult.message}. You MUST try a different approach.]`
                : `\n\n[Warning: ${loopResult.message}]`;

            result = {
              ...result,
              content:
                (typeof result.content === "string"
                  ? result.content
                  : JSON.stringify(result.content)) + annotation,
            };
          }

          // afterToolCall hook — can override result
          const afterEvent = await hooks.emit("after_tool_call", {
            agentType: agent,
            taskId,
            data: { toolName, toolInput, toolUseId, result },
            timestamp: new Date(),
          });

          const finalResult =
            (afterEvent?.data["result"] as ToolResult | undefined) ?? result;

          toolResults.push(finalResult);

          spec.onProgress?.({
            type: "tool_result",
            agentType: agent,
            toolName,
            toolInput,
            toolUseId,
            result: finalResult,
            isError: finalResult.is_error === true,
          });
        }),
      );

      // Sort results to match the original tool_use block order
      const toolUseOrder = toolUseBlocks.map((b: ToolUseBlock) => b.id);
      toolResults.sort((a, b) => {
        const ai = toolUseOrder.indexOf(a.toolUseId);
        const bi = toolUseOrder.indexOf(b.toolUseId);
        return ai - bi;
      });

      // Append tool results + reminder
      messages.push({
        role: "user",
        content: [
          ...toolResults.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.toolUseId,
            content:
              typeof r.content === "string"
                ? r.content
                : JSON.stringify(r.content),
            is_error: r.is_error,
          })),
          {
            type: "text" as const,
            text: buildPostToolReminder(cwd, toolResults),
          },
        ],
      });

      if (turnHandle) clearTimeout(turnHandle);
    } // end main loop

    // ── maxTurns / timeout ─────────────────────────────────────────────────
    const reason = timedOut ? "timeout" : "max_turns";
    const errorMsg =
      reason === "timeout"
        ? formatTimeoutError(timedOutKind, timeoutCfg)
        : `Max turns (${maxTurns}) exceeded`;

    await hooks.emit("after_agent_end", {
      agentType: agent,
      taskId,
      data: {
        succeeded: false,
        output: "",
        turns,
        usage: totalUsage,
        costUsd: totalCost,
        stopReason: reason,
      },
      timestamp: new Date(),
    });

    return finish(false, "", reason, errorMsg);
  } finally {
    for (const h of activeHandles) clearTimeout(h);
  }
}

function formatTimeoutError(
  kind: "total" | "perTurn" | "perLlmCall" | null,
  cfg: { total?: number; perTurn?: number; perLlmCall?: number },
): string {
  switch (kind) {
    case "perTurn":
      return `Agent timeout exceeded — perTurn (${cfg.perTurn}s)`;
    case "perLlmCall":
      return `Agent timeout exceeded — perLlmCall (${cfg.perLlmCall}s)`;
    case "total":
    default:
      return `Agent timeout exceeded — total (${cfg.total}s)`;
  }
}

// ── Default system prompt ─────────────────────────────────────────────────────

function buildDefaultSystemPrompt(agentType: string, notes?: string): string {
  const lines = [
    `You are a ${agentType} agent. Complete the task given to you.`,
    "",
    "## Rules",
    "- Use tools to gather information before making changes.",
    "- Read files before editing them.",
    "- Verify your work before concluding.",
    "- Be precise and efficient — prefer targeted actions over broad sweeps.",
    "- When the task is complete, stop.",
  ];

  if (notes) {
    lines.push("", "## Context", notes);
  }

  return lines.join("\n");
}

// ── Token counting (re-export for callers) ────────────────────────────────────
export { estimateTokens } from "./context-manager.js";
