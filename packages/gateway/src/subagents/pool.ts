import { Session, runAgent, type AgentSpec } from "@squad/runner";
import {
  ToolRegistry,
  type ToolGroupRegistry,
  formatGroupIndexForPrompt,
} from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { SubagentDefinition } from "@squad/protocol";
import type { SessionStore } from "../db/sessions.js";
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

export interface SubagentPoolDeps {
  registry: SubagentRegistry;
  sessions: SessionStore;
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
      title: isAdHoc ? input.name ?? "ad-hoc subagent" : def.name,
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

    const systemPrompt = buildSquadSystemPrompt({
      workspaceDir: this.deps.workspaceDir,
      coreFiles,
      memoryEager,
      ...(toolGroupsIndex ? { toolGroupsIndex } : {}),
    });

    const session = new Session([{ role: "user", content: task }]);

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
      context: { sessionId, parentTaskId: input.parentSessionId },
      ...(this.deps.clientOverride !== undefined ? { clientOverride: this.deps.clientOverride } : {}),
      onTextChunk: (delta) => {
        this.deps.broadcast.publish(`subagents.text_delta/${sessionId}`, {
          sessionId,
          delta,
        });
      },
      onProgress: (update) => {
        if (update.type === "tool_start" && update.toolName) {
          this.deps.broadcast.publish(`subagents.tool_call/${sessionId}`, {
            sessionId,
            toolCallId: update.toolName,
            name: update.toolName,
            input: update.toolInput ?? {},
          });
        } else if (update.type === "tool_result" && update.toolName) {
          this.deps.broadcast.publish(`subagents.tool_result/${sessionId}`, {
            sessionId,
            toolCallId: update.toolName,
            result: update.result,
          });
        }
      },
    };

    return runAgent(spec);
  }
}
