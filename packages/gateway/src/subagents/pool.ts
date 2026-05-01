import { randomUUID } from "node:crypto";
import { Session, runAgent, type AgentSpec } from "@squad/runner";
import {
  ToolRegistry,
  type ToolGroupRegistry,
  formatGroupIndexForPrompt,
} from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { ContentBlock, SubagentDefinition } from "@squad/protocol";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";
import type { SubagentRegistry } from "./registry.js";
import type { ToolsetRegistry } from "../toolsets/registry.js";
import type { MemoryService } from "../memory/service.js";
import {
  buildSquadSystemPrompt,
  loadCoreFilesAt,
  seedCoreFilesAt,
  subagentCoreDir,
  EMPTY_CORE_FILES,
  type CoreFileContents,
} from "../agent-prompt.js";
import {
  discoverContextFiles,
  renderContextFilesSection,
} from "../context-discovery.js";
import { persistRunMessages } from "../run-persistence.js";

export interface PoolLimits {
  maxConcurrentGlobal: number;
  maxConcurrentPerParent: number;
  maxTreeDepth: number;
}

export interface SpawnInput {
  parentSessionId: string;
  /** Registered subagent name. Omit for an ad-hoc spawn. */
  subagent?: string;
  /** First user message handed to the subagent. */
  prompt?: string;
  /** Optional structured payload — JSON-stringified and prepended to the prompt. */
  input?: unknown;
  /** Telemetry label for ad-hoc spawns. */
  name?: string;
  modelOverride?: string;
  toolsets?: string[];
  tools?: string[];
  wait: boolean;
}

export interface SpawnHandle {
  sessionId: string;
  done: Promise<{ result: unknown; tokensIn: number; tokensOut: number; succeeded: boolean }>;
  cancel: () => void;
}

interface RunningEntry {
  sessionId: string;
  parentSessionId: string;
  cancel: () => void;
}

export interface BackgroundOutcome {
  parentSessionId: string;
  sessionId: string;
  subagent: string;
  /** Caller-supplied label for ad-hoc spawns. Undefined for named spawns. */
  name?: string;
  /** True for ad-hoc spawns (subagentDefId is null on the session row). */
  adHoc: boolean;
  succeeded: boolean;
  result: unknown;
  error?: string;
}

export interface SubagentPoolDeps {
  registry: SubagentRegistry;
  sessions: SessionStore;
  /** Used to persist the subagent's user/assistant turns so the dashboard's
   *  `chat.history` can show the transcript when the user clicks the row. */
  messages: MessageStore;
  /** Used to persist tool-call rows so the dashboard inspector can render
   *  the per-call detail the same way it does for the primary chat. */
  toolCalls?: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
  toolRegistry: ToolRegistry;
  /** Persistent agent home directory shared with the parent. */
  workspaceDir: string;
  clientOverride?: LLMClient;
  /** When set, spawn unions resolved toolset tools. */
  toolsets?: ToolsetRegistry;
  /** Tool group registry — used to render the lazy `<tool_groups>` index. */
  toolGroups?: ToolGroupRegistry;
  /** Memory service — when set, named subagents get the eager + retrieval blocks. */
  memory?: MemoryService;
  /** Default model used for ad-hoc spawns when the caller didn't pin one. */
  defaultModel?: string;
  /**
   * Optional runtime registry — when set, subagent definitions with
   * `runtime: <id>` dispatch to the matching runtime instead of running
   * the in-process Squad agent loop. Plugins register runtimes here.
   */
  runtimes?: import("./runtime.js").SubagentRuntimeRegistry;
  /**
   * Fired when a backgrounded spawn (`wait: false`) finishes — succeeded or
   * failed. The gateway uses this to wake the parent session up by injecting
   * a synthetic user message and triggering the next chat turn. Without it,
   * fire-and-forget subagents would drop on the floor and the parent would
   * sit idle waiting for a signal that never arrives.
   */
  onBackgroundOutcome?: (outcome: BackgroundOutcome) => void;
}

export class SubagentPool {
  private readonly running: Map<string, RunningEntry> = new Map();
  private readonly globalWaiters: Array<() => void> = [];
  private readonly perParentWaiters: Map<string, Array<() => void>> = new Map();

  constructor(
    private readonly deps: SubagentPoolDeps,
    private readonly limits: PoolLimits,
  ) {}

  /** Bind the memory service after construction (it boots after the pool). */
  setMemory(memory: MemoryService): void {
    (this.deps as { memory?: MemoryService }).memory = memory;
  }

  /** Bind (or replace) the background-outcome callback after construction. */
  setBackgroundOutcomeHandler(handler: (outcome: BackgroundOutcome) => void): void {
    (this.deps as { onBackgroundOutcome?: (o: BackgroundOutcome) => void }).onBackgroundOutcome = handler;
  }

  spawn(input: SpawnInput): SpawnHandle {
    const def = this.resolveDefinition(input);

    const depth = this.depth(input.parentSessionId);
    if (depth >= this.limits.maxTreeDepth) {
      throw new Error(
        `subagent depth limit (${this.limits.maxTreeDepth}) reached at parent ${input.parentSessionId}`,
      );
    }

    // Resolve any toolset references up front — a missing toolset throws
    // here, before we create the session row.
    const resolvedTools = this.resolveSpawnTools(def, input);
    const isAdHoc = !input.subagent;

    const session = this.deps.sessions.create({
      model: input.modelOverride ?? def.model,
      parentSessionId: input.parentSessionId,
      // Ad-hoc spawns leave subagentDefId null so the row clearly marks the
      // run as one-off.
      ...(isAdHoc ? {} : { subagentDefId: def.name }),
      title: titleForSpawn(input, def, isAdHoc),
    });

    const spawnInput: SpawnInput & { _resolvedTools?: string[]; _adHoc?: boolean } = {
      ...input,
      _resolvedTools: resolvedTools,
      _adHoc: isAdHoc,
    };

    let cancelled = false;
    const abort: () => void = () => {
      cancelled = true;
    };

    const entry: RunningEntry = {
      sessionId: session.id,
      parentSessionId: input.parentSessionId,
      cancel: () => abort(),
    };

    const isBackground = !input.wait;

    const done = (async () => {
      await this.acquire(input.parentSessionId);
      this.running.set(session.id, entry);
      this.deps.broadcast.publish(`subagents.spawned/${input.parentSessionId}`, {
        parentSessionId: input.parentSessionId,
        sessionId: session.id,
        subagent: def.name,
        input: input.input ?? input.prompt ?? null,
      });

      try {
        if (cancelled) throw new Error("cancelled");
        const result = await this.runOne(session.id, def, spawnInput);
        this.deps.broadcast.publish(`subagents.completed/${session.id}`, {
          sessionId: session.id,
          result: result.output,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
        });
        if (isBackground) {
          try {
            this.deps.onBackgroundOutcome?.({
              parentSessionId: input.parentSessionId,
              sessionId: session.id,
              subagent: def.name,
              ...(input.name !== undefined ? { name: input.name } : {}),
              adHoc: isAdHoc,
              succeeded: result.succeeded,
              result: result.output,
            });
          } catch (cbErr) {
            this.deps.logger.error(
              { err: cbErr, sessionId: session.id },
              "onBackgroundOutcome callback threw",
            );
          }
        }
        return {
          result: result.output,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
          succeeded: result.succeeded,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.broadcast.publish(`subagents.failed/${session.id}`, {
          sessionId: session.id,
          error: message,
        });
        if (isBackground) {
          try {
            this.deps.onBackgroundOutcome?.({
              parentSessionId: input.parentSessionId,
              sessionId: session.id,
              subagent: def.name,
              ...(input.name !== undefined ? { name: input.name } : {}),
              adHoc: isAdHoc,
              succeeded: false,
              result: null,
              error: message,
            });
          } catch (cbErr) {
            this.deps.logger.error(
              { err: cbErr, sessionId: session.id },
              "onBackgroundOutcome callback threw",
            );
          }
        }
        throw err;
      } finally {
        this.running.delete(session.id);
        this.release(input.parentSessionId);
      }
    })();

    return {
      sessionId: session.id,
      done,
      cancel: () => entry.cancel(),
    };
  }

  cancelTree(rootSessionId: string): void {
    for (const [id, entry] of this.running) {
      if (entry.parentSessionId === rootSessionId || id === rootSessionId) {
        entry.cancel();
      }
    }
  }

  /**
   * Resolve the SubagentDefinition the spawn should use. For named spawns we
   * look it up in the registry. For ad-hoc spawns we synthesize an ephemeral
   * definition from the caller's input — `tools`/`toolsets`/`model` come
   * straight off the spawn input. The synthesized def carries no
   * systemPrompt — the system prompt is always the Squad system prompt.
   */
  private resolveDefinition(input: SpawnInput): SubagentDefinition {
    if (input.subagent) {
      const def = this.deps.registry.get(input.subagent);
      if (!def) throw new Error(`subagent '${input.subagent}' is not registered`);
      return def;
    }
    const adhocName = input.name ? `adhoc:${input.name}` : "adhoc";
    return {
      name: adhocName,
      description: "Ad-hoc subagent",
      model: input.modelOverride ?? this.deps.defaultModel ?? "claude-sonnet-4-5",
      tools: input.tools ?? [],
      ...(input.toolsets ? { toolsets: input.toolsets } : {}),
    };
  }

  /**
   * Resolve the union of (def.tools ∪ resolved-toolsets ∪ explicit input.tools).
   * Throws on any unknown toolset reference — see ToolsetRegistry.resolve.
   * For ad-hoc spawns with neither tools nor toolsets, returns the parent's
   * full tool list so the agent doesn't have to enumerate.
   */
  private resolveSpawnTools(def: SubagentDefinition, input: SpawnInput): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (name: string): void => {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    };

    for (const t of def.tools) push(t);
    for (const t of input.tools ?? []) push(t);

    const toolsetNames = [...(def.toolsets ?? []), ...(input.toolsets ?? [])];
    if (toolsetNames.length > 0) {
      if (!this.deps.toolsets) {
        throw new Error(
          `subagent "${def.name}" references toolsets but no ToolsetRegistry is configured`,
        );
      }
      for (const ts of toolsetNames) {
        for (const t of this.deps.toolsets.resolve(ts)) push(t);
      }
    }

    // Ad-hoc with no explicit tool list → inherit everything the parent has.
    // Skip describe_tool_group; that's a meta tool for the lazy-loading flow
    // which the subagent doesn't need.
    if (out.length === 0 && !input.subagent) {
      for (const name of this.deps.toolRegistry.names()) {
        if (name === "describe_tool_group") continue;
        push(name);
      }
    }

    return out;
  }

  /** Count children of a given session from the running map + SQLite. */
  private depth(parentSessionId: string): number {
    let depth = 0;
    let current: string | null = parentSessionId;
    while (current) {
      const session = this.deps.sessions.get(current);
      if (!session.parentSessionId) break;
      depth++;
      current = session.parentSessionId;
    }
    return depth;
  }

  private async acquire(parentSessionId: string): Promise<void> {
    const checkCapacity = (): boolean => {
      if (this.running.size >= this.limits.maxConcurrentGlobal) return false;
      const perParent = Array.from(this.running.values()).filter(
        (r) => r.parentSessionId === parentSessionId,
      ).length;
      if (perParent >= this.limits.maxConcurrentPerParent) return false;
      return true;
    };

    if (checkCapacity()) return;

    await new Promise<void>((resolve) => {
      const wait = (): void => {
        if (checkCapacity()) resolve();
        else {
          const list = this.perParentWaiters.get(parentSessionId) ?? [];
          list.push(wait);
          this.perParentWaiters.set(parentSessionId, list);
          this.globalWaiters.push(wait);
        }
      };
      wait();
    });
  }

  private release(parentSessionId: string): void {
    const next = this.globalWaiters.shift();
    if (next) next();
    const perParent = this.perParentWaiters.get(parentSessionId);
    if (perParent) {
      const waiter = perParent.shift();
      if (waiter) waiter();
      if (perParent.length === 0) this.perParentWaiters.delete(parentSessionId);
    }
  }

  private async runOne(
    sessionId: string,
    def: SubagentDefinition,
    input: SpawnInput & { _resolvedTools?: string[]; _adHoc?: boolean },
  ) {
    // External runtime path: dispatch to a registered SubagentRuntime
    // instead of running the in-process Squad agent loop. The pool keeps
    // doing concurrency control / broadcast / session bookkeeping; only
    // the run-it-and-collect-output step is replaced.
    if (def.runtime) {
      return this.runExternalRuntime(sessionId, def, input);
    }

    // Build a filtered tool registry: only tools the subagent definition allows.
    const allowed = input._resolvedTools ?? def.tools;
    const filtered = new ToolRegistry();
    for (const name of allowed) {
      const full = this.deps.toolRegistry.get(name);
      if (!full) continue;
      filtered.register({
        definition: full,
        executor: async (params, cwd, meta) => {
          const res = await this.deps.toolRegistry.execute(
            name,
            params,
            cwd,
            meta,
          );
          return res;
        },
      });
    }

    // First user message: structured input + free-form prompt joined with a
    // blank line. At least one is always present.
    const segments: string[] = [];
    if (input.input !== undefined && input.input !== null) {
      segments.push(typeof input.input === "string" ? input.input : JSON.stringify(input.input));
    }
    if (input.prompt) segments.push(input.prompt);
    const task = segments.join("\n\n") || def.description;

    // Build the Squad system prompt the same way the primary agent does.
    // Named subagents get their own per-name core dir; ad-hoc skip core
    // files entirely. Named subagents also get the memory eager block; we
    // skip retrieval here since subagents don't carry per-turn user input
    // through the chat path.
    let coreFiles: CoreFileContents = EMPTY_CORE_FILES;
    if (!input._adHoc) {
      const coreDir = subagentCoreDir(this.deps.workspaceDir, def.name);
      seedCoreFilesAt(coreDir, def.systemPrompt ? { "SOUL.md": def.systemPrompt } : undefined);
      coreFiles = loadCoreFilesAt(coreDir);
    }
    const memoryEager = input._adHoc
      ? []
      : (await this.deps.memory?.eagerForSession(sessionId)) ?? [];
    const toolGroupsIndex = this.deps.toolGroups
      ? formatGroupIndexForPrompt(this.deps.toolGroups.lazy())
      : undefined;

    const contextFiles = discoverContextFiles(this.deps.workspaceDir);
    const contextFilesSection = renderContextFilesSection(contextFiles);
    if (contextFiles.length > 0) {
      this.deps.broadcast.publish(`context.injected/${sessionId}`, {
        sessionId,
        files: contextFiles.map((f) => ({
          path: f.path,
          name: f.name,
          distance: f.distance,
          tokens: f.tokens,
        })),
      });
    }

    const systemPrompt = buildSquadSystemPrompt({
      workspaceDir: this.deps.workspaceDir,
      coreFiles,
      memoryEager,
      ...(toolGroupsIndex ? { toolGroupsIndex } : {}),
      ...(contextFilesSection ? { contextFilesSection } : {}),
    });

    const session = new Session([{ role: "user", content: task }]);
    const messageCountBefore = session._ref().length;

    // Persist + broadcast the user turn so the dashboard's chat.history (and
    // anyone live-watching this session) sees the same transcript shape it
    // uses for the primary chat. Without this, clicking a subagent row in the
    // sidebar shows a blank pane.
    const userBlocks: ContentBlock[] = [{ type: "text", text: task }];
    const userMessage = this.deps.messages.append({
      sessionId,
      role: "user",
      content: userBlocks,
    });
    this.deps.broadcast.publish(`chat.user_message/${sessionId}`, {
      sessionId,
      message: userMessage,
    });

    const runId = randomUUID();

    // toolUseId → tool_calls row id, so tool_result can complete the row
    // begin() returned. Lifetime is one subagent run.
    const toolCallIdByUseId = new Map<string, string>();

    const spec: AgentSpec = {
      task,
      agent: def.name,
      model: input.modelOverride ?? def.model,
      cwd: this.deps.workspaceDir,
      tools: allowed,
      toolRegistry: filtered,
      timeout: { total: def.limits?.timeoutMs ? Math.ceil(def.limits.timeoutMs / 1000) : 300 },
      maxTokens: def.limits?.maxTokens ?? 16384,
      session,
      systemPrompt,
      context: { sessionId, taskId: runId, parentTaskId: input.parentSessionId },
      ...(this.deps.clientOverride !== undefined ? { clientOverride: this.deps.clientOverride } : {}),
      onTextChunk: (delta) => {
        this.deps.broadcast.publish(`chat.text_delta/${sessionId}`, {
          sessionId,
          runId,
          delta,
        });
        this.deps.broadcast.publish(`subagents.text_delta/${sessionId}`, {
          sessionId,
          delta,
        });
      },
      onProgress: (update) => {
        if (update.type === "tool_start" && update.toolName) {
          const record = this.deps.toolCalls?.begin({
            sessionId,
            runId,
            name: update.toolName,
            input: update.toolInput ?? {},
          });
          const toolCallId = record?.id ?? update.toolUseId ?? update.toolName;
          if (record && update.toolUseId) {
            toolCallIdByUseId.set(update.toolUseId, record.id);
          }
          this.deps.broadcast.publish(`chat.tool_call/${sessionId}`, {
            sessionId,
            runId,
            toolCallId,
            name: update.toolName,
            input: update.toolInput ?? {},
          });
          this.deps.broadcast.publish(`subagents.tool_call/${sessionId}`, {
            sessionId,
            toolCallId,
            name: update.toolName,
            input: update.toolInput ?? {},
          });
        } else if (update.type === "tool_result" && update.toolName) {
          const toolCallId = update.toolUseId
            ? toolCallIdByUseId.get(update.toolUseId)
            : undefined;
          const isError = update.isError === true;
          if (toolCallId) {
            this.deps.toolCalls?.complete(toolCallId, update.result ?? null, isError);
            if (update.toolUseId) toolCallIdByUseId.delete(update.toolUseId);
          }
          const broadcastId = toolCallId ?? update.toolUseId ?? "";
          this.deps.broadcast.publish(`chat.tool_result/${sessionId}`, {
            sessionId,
            runId,
            toolCallId: broadcastId,
            result: update.result,
            ...(isError ? { isError: true } : {}),
          });
          this.deps.broadcast.publish(`subagents.tool_result/${sessionId}`, {
            sessionId,
            toolCallId: broadcastId,
            result: update.result,
          });
        }
      },
    };

    let result;
    try {
      result = await runAgent(spec);
    } catch (err) {
      this.deps.broadcast.publish(`chat.error/${sessionId}`, {
        sessionId,
        runId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    persistRunMessages({
      messages: this.deps.messages,
      broadcast: this.deps.broadcast,
      sessionId,
      session,
      messageCountBefore,
      runId,
      fallbackText: result.output,
    });

    return result;
  }

  private async runExternalRuntime(
    sessionId: string,
    def: SubagentDefinition,
    input: SpawnInput & { _resolvedTools?: string[]; _adHoc?: boolean },
  ) {
    const runtimeId = def.runtime!;
    const runtime = this.deps.runtimes?.get(runtimeId);
    if (!runtime) {
      throw new Error(
        `subagent "${def.name}" requests runtime "${runtimeId}" which is not registered`,
      );
    }

    // Compose the prompt the same way the native runOne does so external
    // agents see the same input shape.
    const segments: string[] = [];
    if (input.input !== undefined && input.input !== null) {
      segments.push(typeof input.input === "string" ? input.input : JSON.stringify(input.input));
    }
    if (input.prompt) segments.push(input.prompt);
    const promptText = segments.join("\n\n") || def.description;

    // Persist + broadcast the user turn so the dashboard's chat.history sees
    // the same transcript shape it uses for native subagents.
    const userBlocks: ContentBlock[] = [{ type: "text", text: promptText }];
    const userMessage = this.deps.messages.append({
      sessionId,
      role: "user",
      content: userBlocks,
    });
    this.deps.broadcast.publish(`chat.user_message/${sessionId}`, {
      sessionId,
      message: userMessage,
    });

    const controller = new AbortController();
    const allowed = input._resolvedTools ?? def.tools;
    const result = await runtime.run({
      prompt: promptText,
      model: input.modelOverride ?? def.model,
      allowedTools: allowed,
      cwd: this.deps.workspaceDir,
      definition: def,
      signal: controller.signal,
      onTextChunk: (delta) => {
        this.deps.broadcast.publish(`subagents.text_delta/${sessionId}`, {
          sessionId,
          delta,
        });
      },
    });

    // Persist the assistant turn so it shows up in the transcript pane.
    const assistantBlocks: ContentBlock[] = [{ type: "text", text: result.output }];
    const assistantMessage = this.deps.messages.append({
      sessionId,
      role: "assistant",
      content: assistantBlocks,
    });
    this.deps.broadcast.publish(`chat.assistant_message/${sessionId}`, {
      sessionId,
      message: assistantMessage,
      runId: sessionId,
    });

    return {
      output: result.output,
      succeeded: result.succeeded,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

/**
 * Resolve the human-readable title for a spawn. Named spawns use the
 * registered name. Ad-hoc spawns prefer the caller-supplied `name` so the
 * sidebar can show meaningful labels; without one we fall back to a generic
 * label suffixed with the prompt's first few words so adjacent runs are
 * distinguishable.
 */
function titleForSpawn(
  input: SpawnInput,
  def: SubagentDefinition,
  isAdHoc: boolean,
): string {
  if (!isAdHoc) return def.name;
  if (input.name && input.name.trim().length > 0) return input.name.trim();
  const promptHint = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (promptHint.length > 0) {
    const firstLine = promptHint.split(/\r?\n/, 1)[0]!.trim();
    const snippet = firstLine.length > 40 ? firstLine.slice(0, 40) + "…" : firstLine;
    return `subagent — ${snippet}`;
  }
  return "subagent";
}
