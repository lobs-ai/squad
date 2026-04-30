import type { ToolsetDescriptor } from "@squad/plugin-sdk";
import type { ToolRegistry } from "@squad/tools";

export class ToolsetUnknownError extends Error {
  readonly toolset: string;
  constructor(toolset: string) {
    super(`unknown toolset: "${toolset}"`);
    this.toolset = toolset;
    this.name = "ToolsetUnknownError";
  }
}

export class ToolsetMissingToolError extends Error {
  readonly toolset: string;
  readonly tool: string;
  constructor(toolset: string, tool: string) {
    super(
      `toolset "${toolset}" references tool "${tool}" which is not registered. ` +
        "Either register the tool first or remove it from the toolset.",
    );
    this.toolset = toolset;
    this.tool = tool;
    this.name = "ToolsetMissingToolError";
  }
}

/**
 * Registry of toolset bundles. A toolset is a packaging indirection — at
 * resolve time it expands to a flat `string[]` of tool ids that the
 * subagent pool unions with any explicit `tools?: string[]`.
 *
 * Validation is strict at resolve time: if the bundle references a tool
 * that the registry has never seen, callers get a clear error rather than
 * a silently shrunk tool list.
 */
export class ToolsetRegistry {
  private readonly entries: Map<string, ToolsetDescriptor> = new Map();

  constructor(private readonly tools: ToolRegistry) {}

  register(def: ToolsetDescriptor): void {
    if (!def.name || def.tools.length === 0) {
      throw new Error(`toolset must have a name and at least one tool: ${JSON.stringify(def)}`);
    }
    this.entries.set(def.name, def);
  }

  list(): ToolsetDescriptor[] {
    return Array.from(this.entries.values());
  }

  get(name: string): ToolsetDescriptor | null {
    return this.entries.get(name) ?? null;
  }

  /**
   * Resolve one toolset to its flat tool-id list. Throws if the toolset is
   * unknown or any of its `requires` / `tools` are not registered.
   */
  resolve(name: string): string[] {
    const def = this.entries.get(name);
    if (!def) throw new ToolsetUnknownError(name);
    const known = new Set(this.tools.names());
    for (const req of def.requires ?? []) {
      if (!known.has(req)) throw new ToolsetMissingToolError(name, req);
    }
    for (const t of def.tools) {
      if (!known.has(t)) throw new ToolsetMissingToolError(name, t);
    }
    return [...def.tools];
  }

  /**
   * Resolve and union multiple toolsets together with an explicit `tools`
   * list. Order is preserved per source; duplicates are collapsed.
   */
  resolveMany(toolsets: string[], tools: string[] = []): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tools) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    for (const ts of toolsets) {
      for (const t of this.resolve(ts)) {
        if (!seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
    }
    return out;
  }
}
