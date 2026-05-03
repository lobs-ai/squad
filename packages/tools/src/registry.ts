// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/tools/src/registry.ts
// Last synced: 2026-04-23

/**
 * ToolRegistry — typed, fluent registry for tool instances.
 *
 * Accepts both `BaseTool` subclass instances and raw `ToolEntry` objects
 * so you can mix class-based and legacy tools in the same registry.
 *
 * @example
 * ```ts
 * import { ToolRegistry } from "@agentic/tools";
 *
 * const registry = new ToolRegistry()
 *   .register(new MyCustomTool())
 *   .registerAll(builtinTools);
 *
 * // Pass to the agent loop
 * await runAgent({ ..., toolRegistry: registry });
 * ```
 */

import type { ToolDefinition, ToolEntry } from "./types.js";
import type { BaseTool } from "./base-tool.js";
import type { PromptContextStore } from "./prompt-context.js";

function isBaseTool(t: BaseTool | ToolEntry): t is BaseTool {
  return typeof (t as BaseTool).run === "function";
}

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolEntry>();
  /** Tracks every BaseTool instance so we can hand them a PromptContextStore. */
  private readonly _baseTools: Set<BaseTool> = new Set();
  private _promptContextStore: PromptContextStore | null = null;

  /**
   * Register a single tool.
   * Accepts a `BaseTool` instance or a raw `{ definition, executor }` entry.
   * Returns `this` for chaining.
   */
  register(tool: BaseTool | ToolEntry): this {
    if (isBaseTool(tool)) {
      this._baseTools.add(tool);
      if (this._promptContextStore) tool.setPromptContextStore(this._promptContextStore);
      const entry = tool.toEntry();
      this._tools.set(entry.definition.name, entry);
    } else {
      this._tools.set(tool.definition.name, tool);
    }
    return this;
  }

  /**
   * Attach a {@link PromptContextStore} so every BaseTool registered here can
   * render dynamic descriptions. Tools that registered before this call are
   * back-filled. Idempotent.
   */
  setPromptContextStore(store: PromptContextStore): void {
    this._promptContextStore = store;
    for (const tool of this._baseTools) tool.setPromptContextStore(store);
  }

  /**
   * Register multiple tools at once.
   * Returns `this` for chaining.
   */
  registerAll(tools: Array<BaseTool | ToolEntry>): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /**
   * Return tool definitions for the given names (or all registered tools
   * when `names` is omitted).
   */
  getDefinitions(names?: string[]): ToolDefinition[] {
    if (!names || names.length === 0) {
      return Array.from(this._tools.values()).map((t) => t.definition);
    }
    const defs: ToolDefinition[] = [];
    for (const name of names) {
      const entry = this._tools.get(name);
      if (entry) defs.push(entry.definition);
    }
    return defs;
  }

  /**
   * Execute a tool by name.
   *
   * @param name   Registered tool name.
   * @param params Tool input parameters.
   * @param cwd    Working directory for file/exec operations.
   * @param meta   Optional agent context (userId, sessionId, etc.) passed
   *               through to `ToolContext.meta` inside the tool's `run()`.
   *
   * @throws When the tool name is not registered.
   */
  execute(
    name: string,
    params: Record<string, unknown>,
    cwd: string,
    meta?: Record<string, unknown>,
  ) {
    const entry = this._tools.get(name);
    if (!entry) return Promise.reject(new Error(`Unknown tool: "${name}"`));
    return entry.executor(params, cwd, meta);
  }

  /** Return true if a tool with the given name is registered. */
  has(name: string): boolean {
    return this._tools.has(name);
  }

  /** Return all registered tool names. */
  names(): string[] {
    return Array.from(this._tools.keys());
  }

  /**
   * Return the definition for a single tool, or `undefined` if not found.
   *
   * @example
   * ```ts
   * const def = registry.get("exec");
   * console.log(def?.tags); // ["exec", "shell"]
   * ```
   */
  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name)?.definition;
  }

  /**
   * Return the names of all tools that satisfy `predicate`.
   *
   * @example Keep only readonly tools
   * ```ts
   * const safe = registry.filter(def => def.tags?.includes("readonly") ?? false);
   * ```
   *
   * @example Exclude exec and write
   * ```ts
   * const restricted = registry.filter(
   *   def => !def.tags?.some(t => ["exec", "write"].includes(t)),
   * );
   * ```
   */
  filter(predicate: (def: ToolDefinition) => boolean): string[] {
    const names: string[] = [];
    for (const [name, entry] of this._tools) {
      if (predicate(entry.definition)) names.push(name);
    }
    return names;
  }

  /**
   * Return the names of all tools that carry **at least one** of the given tags.
   *
   * Built-in tags: `"readonly"`, `"write"`, `"exec"`, `"filesystem"`,
   * `"search"`, `"directory"`, `"shell"`.
   *
   * @example
   * ```ts
   * registry.tagged("readonly")           // all read-safe tools
   * registry.tagged("write", "exec")      // write + exec tools combined
   * ```
   */
  tagged(...tags: string[]): string[] {
    const tagSet = new Set(tags);
    return this.filter(
      (def) => def.tags?.some((t) => tagSet.has(t)) ?? false,
    );
  }

  /** Number of registered tools. */
  get size(): number {
    return this._tools.size;
  }
}
