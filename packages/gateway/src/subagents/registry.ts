import type { SubagentDefinition } from "@squad/protocol";

export type RegistrySource = "plugin" | "user" | "builtin";

interface Entry {
  def: SubagentDefinition;
  source: RegistrySource;
}

export interface RegistryListener {
  (event: { kind: "registered" | "unregistered"; name: string; source: RegistrySource }): void;
}

/**
 * In-process registry of subagent definitions. Plugin-registered entries
 * carry source=`plugin`; user-created entries (via `create_subagent` /
 * `subagents.create`) carry source=`user` and are also persisted to
 * `subagent_defs` so they survive a restart. Hot-reloadable: registrations
 * land in the running pool with no boot-time gate.
 */
export class SubagentRegistry {
  private readonly byName: Map<string, Entry> = new Map();
  private readonly listeners: RegistryListener[] = [];

  register(def: SubagentDefinition, source: RegistrySource = "plugin"): void {
    this.byName.set(def.name, { def, source });
    for (const l of this.listeners) l({ kind: "registered", name: def.name, source });
  }

  unregister(name: string): boolean {
    const entry = this.byName.get(name);
    if (!entry) return false;
    this.byName.delete(name);
    for (const l of this.listeners) {
      l({ kind: "unregistered", name, source: entry.source });
    }
    return true;
  }

  get(name: string): SubagentDefinition | undefined {
    return this.byName.get(name)?.def;
  }

  sourceOf(name: string): RegistrySource | undefined {
    return this.byName.get(name)?.source;
  }

  list(): SubagentDefinition[] {
    return Array.from(this.byName.values()).map((e) => e.def);
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }
}
