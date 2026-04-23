import type { SubagentDefinition } from "@squad/protocol";

/**
 * In-process registry of subagent definitions. Populated by plugins and read
 * by the spawn path. Authoritative over the `subagent_defs` SQLite table —
 * the table is a cache for the tree view to resolve names after a plugin
 * unload.
 */
export class SubagentRegistry {
  private readonly byName: Map<string, SubagentDefinition> = new Map();

  register(def: SubagentDefinition): void {
    this.byName.set(def.name, def);
  }

  unregister(name: string): void {
    this.byName.delete(name);
  }

  get(name: string): SubagentDefinition | undefined {
    return this.byName.get(name);
  }

  list(): SubagentDefinition[] {
    return Array.from(this.byName.values());
  }
}
