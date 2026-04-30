import { Session, runAgent, type AgentSpec } from "@squad/runner";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { SubagentDefinition } from "@squad/protocol";
import type { SessionStore } from "../db/sessions.js";
import type { Broadcast } from "../broadcast.js";
import type { Logger } from "../logger.js";
import type { SubagentRegistry } from "./registry.js";
import type { ToolsetRegistry } from "../toolsets/registry.js";

export interface PoolLimits {
  maxConcurrentGlobal: number;
  maxConcurrentPerParent: number;
  maxTreeDepth: number;
}

export interface SpawnInput {
  parentSessionId: string;
  subagent: string;
  input: unknown;
  modelOverride?: string;
  /**
   * Optional list of toolset names. Unioned with the definition's
   * `toolsets` and the def's explicit `tools`; resolved against the
   * gateway's ToolsetRegistry at spawn time.
   */
  toolsets?: string[];
  /**
   * Optional ad-hoc tool list. Unioned with whatever the definition and
   * any toolsets resolve to.
   */
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
  /** Optional — when set, spawn unions resolved toolset tools. */
  toolsets?: ToolsetRegistry;
}

export class SubagentPool {
  private readonly running: Map<string, RunningEntry> = new Map();
  private readonly globalWaiters: Array<() => void> = [];
  private readonly perParentWaiters: Map<string, Array<() => void>> = new Map();

  constructor(
    private readonly deps: SubagentPoolDeps,
    private readonly limits: PoolLimits,
  ) {}

  spawn(input: SpawnInput): SpawnHandle {
    const def = this.deps.registry.get(input.subagent);
    if (!def) throw new Error(`subagent '${input.subagent}' is not registered`);

    const depth = this.depth(input.parentSessionId);
    if (depth >= this.limits.maxTreeDepth) {
      throw new Error(
        `subagent depth limit (${this.limits.maxTreeDepth}) reached at parent ${input.parentSessionId}`,
      );
    }

    // Resolve any toolset references up front — a missing toolset throws
    // here, before we create the session row. The resolved list flows into
    // runOne via spawn-input shadow on the local entry.
    const resolvedTools = this.resolveSpawnTools(def, input);

    const session = this.deps.sessions.create({
      model: input.modelOverride ?? def.model,
      parentSessionId: input.parentSessionId,
      subagentDefId: def.name,
      title: `${def.name}`,
    });

    // Stash the resolved tool list on the input so runOne uses it instead of
    // def.tools alone. Avoids changing every internal signature.
    const spawnInput: SpawnInput & { _resolvedTools?: string[] } = {
      ...input,
      _resolvedTools: resolvedTools,
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
        input: input.input,
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
   * Resolve the union of (def.tools ∪ resolved-toolsets ∪ explicit input.tools).
   * Throws on any unknown toolset reference — see ToolsetRegistry.resolve.
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
    input: SpawnInput & { _resolvedTools?: string[] },
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

    // Seed the subagent's message history with the structured task input.
    const task = JSON.stringify(input.input);
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
      systemPrompt: def.systemPrompt,
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
