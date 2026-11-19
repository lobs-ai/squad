/**
 * Harness turn execution — the gateway side of the external-harness path.
 *
 * `runChatTurn` builds the shared turn context (history, memory, system prompt,
 * tool split, render context) and, when a session is bound to an external
 * harness, delegates the actual model loop here instead of to the in-process
 * `runAgent`. We consume the normalized HarnessEvent stream and drive the SAME
 * broadcast / persistence callbacks the runner path uses, so every client sees
 * an identical turn — only the engine behind it changed.
 */

import type {
  ApprovalHook,
  HarnessAuth,
  HarnessFactory,
  HarnessKind,
  HarnessStartSpec,
  HarnessSurface,
  HarnessToolDef,
  SquadToolExecutor,
} from "@squad/harness";
import type { AgentResult, ProgressUpdate } from "@squad/runner";
import type { ToolRegistry } from "@squad/tools";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { Broadcast } from "./broadcast.js";
import type { Logger } from "./logger.js";

/**
 * Squad tool name → Claude Code native built-in. Tools in this map are served
 * by the harness's own implementation (Read/Edit/Bash/…) rather than exposed
 * as squad MCP primitives, so they're filtered out of the MCP toolset.
 *
 * Mirrors SQUAD_TO_CC_TOOL_MAP in @squad/llm's claude-cli provider; kept local
 * so the gateway doesn't reach into that provider's internals.
 */
export const NATIVE_TOOL_MAP: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  exec: "Bash",
  grep: "Grep",
  glob: "Glob",
  find_files: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

/** Boot-built dependencies for the harness path, threaded via RunDeps. */
export interface HarnessRuntimeDeps {
  /** Harness kind new (history-free) sessions adopt; null = legacy runner only. */
  defaultKind: HarnessKind | null;
  factory(kind: HarnessKind): HarnessFactory;
  auth(kind: HarnessKind): HarnessAuth;
  /** Isolated config/transcript/cred dir (under data_dir). */
  configDir: string;
  /** Squad tool name → native built-in; primitives are everything NOT in here. */
  nativeToolMap: Readonly<Record<string, string>>;
  /** Native leaf tools the harness may use this turn (Read/Edit/Bash/…). */
  nativeTools: string[];
  /** Per-tool-call approval bridge (Phase 1: allow-all). */
  approval: ApprovalHook;
}

export interface RunHarnessTurnParams {
  harness: HarnessRuntimeDeps;
  kind: HarnessKind;
  sessionId: string;
  runId: string;
  /** Harness-namespace model id (provider prefix stripped). */
  model: string;
  /** Harness-side session id to resume; null on the first turn. */
  resume: string | null;
  /** Whether the session already had a harness_kind (controls sticky write). */
  hadKind: boolean;
  /** Appended to the harness's own system prompt — stable per session. */
  appendSystemPrompt: string;
  /** Squad primitives to expose as MCP tools this turn (natives excluded). */
  squadToolDefs: HarnessToolDef[];
  toolRegistry: ToolRegistry;
  cwd: string;
  surface: HarnessSurface;
  input: { text: string };
  /** Reused from runChatTurn — already wired to broadcast / tool_calls. */
  onTextChunk?: (delta: string) => void;
  onProgress?: (update: ProgressUpdate) => void;
  deps: { sessions: SessionStore; messages: MessageStore; broadcast: Broadcast; logger: Logger };
}

/** Run one turn through the external harness; returns a runner-shaped result. */
export async function runHarnessTurn(p: RunHarnessTurnParams): Promise<AgentResult> {
  const execute: SquadToolExecutor = async (name, params) => {
    const r = await p.toolRegistry.execute(name, params, p.cwd, {
      sessionId: p.sessionId,
      taskId: p.runId,
    });
    if (typeof r === "string") return r;
    if (r && typeof r === "object" && "result" in r) {
      const result = (r as { result: unknown }).result;
      return typeof result === "string" ? result : JSON.stringify(result);
    }
    return JSON.stringify(r);
  };

  const startSpec: HarnessStartSpec = {
    sessionId: p.sessionId,
    ...(p.resume ? { resume: p.resume } : {}),
    model: p.model,
    auth: p.harness.auth(p.kind),
    cwd: p.cwd,
    configDir: p.harness.configDir,
    appendSystemPrompt: p.appendSystemPrompt,
    squadTools: { tools: p.squadToolDefs, execute },
    allowedNativeTools: p.harness.nativeTools,
    surface: p.surface,
  };

  const session = await p.harness.factory(p.kind).open(startSpec, p.harness.approval);

  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let stopReason = "end_turn";
  const toolNameById = new Map<string, string>();

  try {
    for await (const ev of session.runTurn(p.input)) {
      switch (ev.t) {
        case "text.delta":
          output += ev.text;
          p.onTextChunk?.(ev.text);
          break;
        case "thinking.delta":
          // Reasoning streams on its own topic — never persisted as message text.
          p.deps.broadcast.publish(`chat.thinking_delta/${p.sessionId}`, {
            sessionId: p.sessionId,
            runId: p.runId,
            delta: ev.text,
          });
          break;
        case "tool.start":
          toolNameById.set(ev.id, ev.name);
          p.onProgress?.({
            type: "tool_start",
            agentType: "default",
            toolName: ev.name,
            toolInput: (ev.input ?? {}) as Record<string, unknown>,
            toolUseId: ev.id,
          });
          break;
        case "tool.end":
          p.onProgress?.({
            type: "tool_result",
            agentType: "default",
            toolName: toolNameById.get(ev.id) ?? "tool",
            toolUseId: ev.id,
            result: ev.output,
            isError: ev.isError,
          });
          break;
        case "turn.end":
          inputTokens = ev.usage.inputTokens;
          outputTokens = ev.usage.outputTokens;
          cacheReadTokens = ev.usage.cacheReadTokens ?? 0;
          cacheWriteTokens = ev.usage.cacheWriteTokens ?? 0;
          costUsd = ev.usage.costUsd ?? 0;
          stopReason = ev.stopReason;
          break;
        case "error":
          stopReason = "error";
          p.deps.logger.warn(
            { sessionId: p.sessionId, category: ev.category, message: ev.message },
            "harness error event",
          );
          break;
        default:
          break;
      }
    }
  } finally {
    // Capture the harness session id for resume, and pin the kind on first use.
    const hsid = session.harnessSessionId();
    if (hsid) {
      p.deps.sessions.setHarnessSessionId(p.sessionId, hsid);
      if (!p.hadKind) p.deps.sessions.setHarnessKind(p.sessionId, p.kind);
    }
    await session.close();
  }

  // Finalize: persist the assistant message and broadcast it (mirrors
  // RunPersister.finalize). Tool calls were already persisted/broadcast via
  // the reused onProgress callback, and render from the tool_calls table.
  const assistant = p.deps.messages.append({
    sessionId: p.sessionId,
    role: "assistant",
    content: [{ type: "text", text: output }],
  });
  p.deps.broadcast.publish(`chat.assistant_message/${p.sessionId}`, {
    sessionId: p.sessionId,
    message: assistant,
    runId: p.runId,
  });

  return {
    succeeded: stopReason !== "error",
    output,
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    costUsd,
    turns: 1,
    runId: p.runId,
  };
}
