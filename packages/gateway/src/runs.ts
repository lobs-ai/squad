import { runAgent, Session, compactMessages } from "@squad/runner";
import type { AgentSpec, AgentResult } from "@squad/runner";
import {
  ToolRegistry,
  type ToolGroupRegistry,
  type PromptContextStore,
  type RenderContext,
  formatGroupIndexForPrompt,
  PROMPT_SLOTS,
} from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { ContentBlock, MessageRecord } from "@squad/protocol";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { ToolCallStore } from "./db/tool-calls.js";
import type { Broadcast } from "./broadcast.js";
import type { Logger } from "./logger.js";
import { buildSquadSystemPrompt, loadCoreFiles } from "./agent-prompt.js";
import {
  discoverContextFiles,
  renderContextFilesSection,
} from "./context-discovery.js";
import type { MemoryService } from "./memory/service.js";
import {
  toLLMContent,
  RunPersister,
  ensureIncrementalFlushHook,
  registerActivePersister,
  unregisterActivePersister,
} from "./run-persistence.js";

function textBlocks(content: ContentBlock[] | string): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export interface RunOptions {
  sessionId: string;
  /**
   * Absolute path the runner uses as cwd. Persistent across sessions —
   * the gateway resolves and mkdirs it once at boot. Tools that touch the
   * filesystem or shell out land here.
   */
  cwd: string;
  /**
   * Correlation id for this run. The delivery coordinator generates this
   * before start() fires so it can register hooks keyed on the same id the
   * runner sees via `context.taskId`.
   */
  runId: string;
  /**
   * Content the turn starts with. May be empty for queue-mode follow-on
   * turns that consume an existing user message from history.
   */
  userContent: ContentBlock[];
  /**
   * When true, persist `userContent` as a new user message and broadcast it.
   * Set to false when the caller already wrote the user message (e.g., when
   * a queued message's row was persisted at enqueue time).
   */
  persistUserMessage: boolean;
  model: string;
  /** Ordered fallback models for this session's sticky chain. */
  fallbacks?: string[];
  systemPrompt?: string;
  toolRegistry: ToolRegistry;
  /**
   * Optional allow-list of tool names. When provided, only tools whose names
   * appear here are exposed to the LLM. Names not present in the registry are
   * silently dropped. Used by cron jobs that scope tool access per-routine.
   *
   * When provided, this completely overrides the per-session tool-group
   * computation — callers that pin a specific tool list bypass lazy loading.
   */
  toolsAllow?: string[];
  /**
   * Optional tool-group registry. When provided AND `toolsAllow` is not set,
   * runs.ts computes the per-turn allow-list from the default groups plus
   * whichever non-default groups the session has unlocked via
   * `describe_tool_group`. Without it (or `toolsAllow`), every tool in the
   * registry is exposed each turn (legacy behavior).
   */
  toolGroups?: ToolGroupRegistry;
  clientOverride?: LLMClient;
  /** Fires once the user message row has been written to SQLite. */
  onUserMessagePersisted?: (msg: MessageRecord) => void;
  /**
   * Hook the coordinator uses to register the active run *before* the agent
   * loop starts calling hooks. Returning the Session lets the coordinator
   * mutate history mid-run for interrupt mode.
   */
  onRunStart?: (ctx: { runId: string; sessionId: string; session: Session }) => void;
  onRunEnd?: (ctx: { runId: string; sessionId: string }) => Promise<void> | void;
  /**
   * Polled by the runner between turns. When this first returns true the
   * agent loop bails at the next safe checkpoint. Wired by chat dispatch
   * to read the coordinator's per-run cancellation flag.
   */
  shouldCancel?: () => boolean;
}

export interface RunDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
  /** Optional — when set, every turn injects the eager + retrieval blocks. */
  memory?: MemoryService;
  /**
   * Optional — registers runId→sessionId so the trace hook publishes
   * trace.step events scoped to the correct session. Tests can omit.
   */
  traceRegistry?: import("./traces.js").TraceSessionRegistry;
  /**
   * Pre-rendered runtime-environment section. When present, runs.ts
   * forwards it to `buildSquadSystemPrompt` so every turn carries a "where
   * am I running" briefing for the agent. Tests can omit.
   */
  runtimeEnvSection?: string;
  /**
   * Live PromptContext store. When set, runs.ts wraps the runAgent call in
   * `store.runWithRender(render, …)` so tool descriptions render against
   * the per-turn RenderContext (channel kind, surface, capabilities). Tests
   * can omit; tools then fall back to their static descriptions.
   */
  promptContextStore?: PromptContextStore;
  /**
   * Map a sessionId to a RenderContext. Wired by the gateway from the
   * channel registry — when the session is bound to a channel, returns
   * `{ surface: "channel", channelKind, … }`; otherwise dashboard / cli /
   * subagent / cron-isolated as appropriate.
   */
  renderContextFor?: (sessionId: string) => RenderContext;
}

/**
 * Persist the user message, start an agent run, stream deltas through
 * the broadcast bus, and persist the assistant message on completion.
 *
 * Phase 3 scope: text in, text out, tools optional. Tool-call events
 * publish to `chat.tool_call` / `chat.tool_result` but the tool registry
 * is empty unless the caller supplies one.
 */
export async function runChatTurn(
  options: RunOptions,
  deps: RunDeps,
): Promise<{ userMessage: MessageRecord | null; runId: string; result: AgentResult }> {
  const runId = options.runId;
  let userMessage: MessageRecord | null = null;
  if (options.persistUserMessage) {
    userMessage = deps.messages.append({
      sessionId: options.sessionId,
      role: "user",
      content: options.userContent,
    });
    deps.broadcast.publish(`chat.user_message/${options.sessionId}`, {
      sessionId: options.sessionId,
      message: userMessage,
    });
    options.onUserMessagePersisted?.(userMessage);
  }

  // From here on, any throw — whether during setup (memory retrieval,
  // context discovery, system prompt build) or inside runAgent itself —
  // must be broadcast as chat.error/{sessionId}. Otherwise the dashboard /
  // CLI / Discord sit on awaitingResponse forever waiting for an
  // assistant message that will never arrive.
  let persister: RunPersister | undefined;
  let result: AgentResult;
  try {
    // Pull the full session history and feed it to the runner. Persisted
    // role:"tool" messages (containing tool_result blocks) get folded back
    // into role:"user" the way the runner produced them — the LLM doesn't
    // see a "tool" role; tool results ride inside user turns.
    const history = deps.messages.listForSession(options.sessionId, 1000);
    let runnerMessages = history
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
      .map((m) => ({
        role: (m.role === "tool" ? "user" : m.role) as "user" | "assistant",
        content: toLLMContent(m.content),
      }));

    // Manual /compact armed the session — drop older turns before handing the
    // history to the runner, then clear the flag. The runner's per-turn auto-
    // compact still kicks in on top of this for long-running sessions.
    if (deps.sessions.getCompactAtStart(options.sessionId)) {
      runnerMessages = compactMessages(runnerMessages);
      deps.sessions.clearCompactAtStart(options.sessionId);
      deps.logger.info(
        { sessionId: options.sessionId, before: history.length, after: runnerMessages.length },
        "session compacted on /compact request",
      );
    }

    deps.sessions.setStatus(options.sessionId, "running");
    deps.traceRegistry?.register(runId, options.sessionId);

    // High-water mark: anything beyond this in session._ref() at end-of-run
    // is new this turn and needs to be persisted.
    const messageCountBefore = runnerMessages.length;
    const session = new Session(runnerMessages);
    options.onRunStart?.({ runId, sessionId: options.sessionId, session });

    // Incremental persister: flushes after every LLM call so a crash
    // mid-run doesn't strand the dashboard with a turn's worth of missing
    // tool calls. The flush itself is driven by the shared `before_llm_call`
    // hook installed below; we register this run's persister into the
    // module-level map keyed by runId.
    ensureIncrementalFlushHook(deps.logger);
    persister = new RunPersister({
      messages: deps.messages,
      broadcast: deps.broadcast,
      sessionId: options.sessionId,
      session,
      runId,
      messageCountBefore,
    });
    registerActivePersister(runId, persister);

    // Default system prompt: Squad onboarding + the live core files. Read core
    // files at the top of every turn so edits the agent makes mid-session
    // (write/edit on .squad/*.md) take effect on the next turn. Caller-supplied
    // systemPrompt still wins — tests and bespoke flows opt out this way.
    // Memory blocks: eager is frozen per session (kept inside the cacheable
    // prefix); retrieval is per-turn against the latest user input.
    // Memory eager + retrieval — both are *supplementary*. A failure in the
    // memory subsystem (embedder unreachable, model not pulled, query too
    // long for the embedder's context window) must NOT kill the chat turn:
    // the agent still has its core files, system prompt, and history. Log
    // it and continue with empty memory blocks so the user sees the agent
    // respond instead of a confusing "model unreachable" error.
    let memoryEager: Awaited<ReturnType<NonNullable<typeof deps.memory>["eagerForSession"]>> = [];
    try {
      memoryEager = (await deps.memory?.eagerForSession(options.sessionId)) ?? [];
    } catch (memErr) {
      deps.logger.warn(
        { err: memErr, sessionId: options.sessionId },
        "memory eager fetch failed — continuing with empty eager block",
      );
    }
    // Build the retrieval query from a sliding window of the most recent
    // user messages plus the current turn. Catches "earlier I told you
    // about X — now what about Y" follow-ups that a current-turn-only
    // query would miss. We cap at the last 2 prior user messages so the
    // embedder context stays bounded and retrieval doesn't drown in stale
    // chatter from the start of a long session.
    const currentText = options.userContent
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    // `runnerMessages` already excludes tool_results; pull the trailing
    // user turns from it. Skip the LAST user turn — that's the current
    // input we just persisted (or are about to consume), already in
    // `currentText`.
    const userTurns = runnerMessages.filter((m) => m.role === "user");
    const priorUserTexts = userTurns
      .slice(-3, -1) // up to 2 prior user turns
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((t) => t.length > 0);
    const userQuery = [...priorUserTexts, currentText]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n---\n\n");
    // No manual cap — MemoryService.retrievalForTurn now reads the
    // embedder's `maxInputChars` and chunks long queries, preserving
    // signal from the entire window instead of truncating it.
    const treeRoot = deps.sessions.rootId(options.sessionId);
    let memoryRetrieval: Awaited<ReturnType<NonNullable<typeof deps.memory>["retrievalForTurn"]>> = [];
    try {
      memoryRetrieval =
        (await deps.memory?.retrievalForTurn(userQuery, { scopeKey: treeRoot })) ?? [];
    } catch (memErr) {
      deps.logger.warn(
        { err: memErr, sessionId: options.sessionId, queryLen: userQuery.length },
        "memory retrieval failed — continuing without retrieval block",
      );
    }

    // Compute the per-turn tool allow-list. Priority:
    //   1. options.toolsAllow — caller pinned a specific list (e.g. cron jobs).
    //   2. toolGroups + per-session unlocked set — the lazy-loading path.
    //   3. Fall back to "every registered tool" for legacy callers.
    let activeTools: string[] | undefined = options.toolsAllow;
    if (!activeTools && options.toolGroups) {
      const unlocked = deps.sessions.getUnlockedGroups(options.sessionId);
      activeTools = [
        ...options.toolGroups.activeToolNames(unlocked),
        "describe_tool_group",
      ];
    }

    const toolGroupsIndex =
      options.toolGroups && !options.toolsAllow
        ? formatGroupIndexForPrompt(options.toolGroups.lazy())
        : undefined;

    // Project context discovery: walk up from cwd looking for AGENTS.md / CLAUDE.md
    // / SQUAD.md / .cursorrules. Caps at ~8K tokens, drops farthest first when over.
    const contextFiles = discoverContextFiles(options.cwd);
    const contextFilesSection = renderContextFilesSection(contextFiles);
    if (contextFiles.length > 0) {
      deps.broadcast.publish(`context.injected/${options.sessionId}`, {
        sessionId: options.sessionId,
        runId,
        files: contextFiles.map((f) => ({
          path: f.path,
          name: f.name,
          distance: f.distance,
          tokens: f.tokens,
        })),
      });
    }

    const renderForPrompt = deps.renderContextFor?.(options.sessionId);
    const baseStartupWarnings = deps.promptContextStore?.get().startupWarnings ?? [];
    const fragmentStartupWarnings =
      deps.promptContextStore && renderForPrompt
        ? deps.promptContextStore.fragmentsFor(
            PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
            renderForPrompt,
          )
        : [];
    const startupWarnings = [...baseStartupWarnings, ...fragmentStartupWarnings];
    const systemPrompt =
      options.systemPrompt ??
      buildSquadSystemPrompt({
        workspaceDir: options.cwd,
        coreFiles: loadCoreFiles(options.cwd),
        memoryEager,
        memoryRetrieval,
        ...(toolGroupsIndex ? { toolGroupsIndex } : {}),
        ...(contextFilesSection ? { contextFilesSection } : {}),
        ...(deps.runtimeEnvSection ? { runtimeEnvSection: deps.runtimeEnvSection } : {}),
        ...(startupWarnings.length > 0 ? { startupWarnings } : {}),
      });

    // toolUseId → tool_calls row id, so tool_result can find the row begin()
    // returned and mark it completed. Cleared on each result; lifetime is one run.
    const toolCallIdByUseId = new Map<string, string>();

    const spec: AgentSpec = {
      task:
        options.userContent
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n") || "",
      agent: "default",
      model: options.model,
      fallbacks: options.fallbacks ?? [],
      cwd: options.cwd,
      tools: activeTools
        ? options.toolRegistry.names().filter((n) => activeTools!.includes(n))
        : options.toolRegistry.names(),
      toolRegistry: options.toolRegistry,
      timeout: { total: 300 },
      session,
      systemPrompt,
      // taskId must equal runId so the before_llm_call hook can correlate.
      context: { sessionId: options.sessionId, taskId: runId },
      ...(options.clientOverride !== undefined ? { clientOverride: options.clientOverride } : {}),
      ...(options.shouldCancel ? { shouldCancel: options.shouldCancel } : {}),
      onTextChunk: (delta) => {
        deps.broadcast.publish(`chat.text_delta/${options.sessionId}`, {
          sessionId: options.sessionId,
          runId,
          delta,
        });
      },
      onProgress: (update) => {
        if (update.type === "tool_start" && update.toolName) {
          const record = deps.toolCalls.begin({
            sessionId: options.sessionId,
            runId,
            name: update.toolName,
            input: update.toolInput ?? {},
          });
          if (update.toolUseId) toolCallIdByUseId.set(update.toolUseId, record.id);
          deps.broadcast.publish(`chat.tool_call/${options.sessionId}`, {
            sessionId: options.sessionId,
            runId,
            toolCallId: record.id,
            name: update.toolName,
            input: update.toolInput ?? {},
          });
        } else if (update.type === "tool_result" && update.toolName) {
          const toolCallId = update.toolUseId
            ? toolCallIdByUseId.get(update.toolUseId)
            : undefined;
          const isError = update.isError === true;
          if (toolCallId) {
            deps.toolCalls.complete(toolCallId, update.result ?? null, isError);
            if (update.toolUseId) toolCallIdByUseId.delete(update.toolUseId);
          }
          deps.broadcast.publish(`chat.tool_result/${options.sessionId}`, {
            sessionId: options.sessionId,
            runId,
            toolCallId: toolCallId ?? "",
            result: update.result,
            ...(isError ? { isError: true } : {}),
          });
        }
      },
    };

    if (deps.promptContextStore && renderForPrompt) {
      result = await deps.promptContextStore.runWithRender(renderForPrompt, () => runAgent(spec));
    } else {
      result = await runAgent(spec);
    }
  } catch (err) {
    // Persist whatever made it onto Session._ref() before the throw so the
    // dashboard's transcript reflects the partial turn instead of going
    // blank. Then tell subscribers the run failed — otherwise CLI/dashboard
    // sit waiting for a chat.assistant_message that will never arrive.
    try {
      persister?.flush();
    } catch (flushErr) {
      deps.logger.error(
        { err: flushErr, runId },
        "final flush after run error failed",
      );
    }
    deps.broadcast.publish(`chat.error/${options.sessionId}`, {
      sessionId: options.sessionId,
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    unregisterActivePersister(runId);
    deps.sessions.setStatus(options.sessionId, "idle");
    deps.traceRegistry?.unregister(runId);
    await options.onRunEnd?.({ runId, sessionId: options.sessionId });
  }

  deps.sessions.addTokens(
    options.sessionId,
    result.usage.inputTokens,
    result.usage.outputTokens,
  );

  persister!.finalize(result.output);

  return { userMessage, runId, result };
}

// Re-export textBlocks for the chat dispatcher to normalize input.
export { textBlocks };
