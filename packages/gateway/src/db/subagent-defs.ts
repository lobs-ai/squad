import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./index.js";
import type { SubagentDefinition } from "@squad/protocol";

interface SubagentDefRow {
  id: string;
  name: string;
  version: string;
  config_json: string;
  registered_at: string;
}

/**
 * Persists user-created subagent definitions so they survive a gateway
 * restart. Plugin-registered subagents are not stored here — plugins reload
 * themselves at boot. Only definitions written through `create_subagent`
 * (and friends) land in this table.
 */
export class SubagentDefStore {
  constructor(private readonly db: DatabaseHandle) {}

  list(): SubagentDefinition[] {
    const rows = this.db.prepare<SubagentDefRow>("SELECT * FROM subagent_defs ORDER BY name").all();
    return rows.map((r) => JSON.parse(r.config_json) as SubagentDefinition);
  }

  get(name: string): SubagentDefinition | null {
    const row = this.db
      .prepare<SubagentDefRow>("SELECT * FROM subagent_defs WHERE name = ?")
      .get(name);
    return row ? (JSON.parse(row.config_json) as SubagentDefinition) : null;
  }

  /** Insert or replace by name. */
  upsert(def: SubagentDefinition): void {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO subagent_defs (id, name, version, config_json, registered_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           config_json = excluded.config_json,
           version = excluded.version,
           registered_at = excluded.registered_at`,
      )
      .run(id, def.name, "1", JSON.stringify(def), now);
  }

  delete(name: string): boolean {
    const res = this.db
      .prepare<unknown, { changes: number }>("DELETE FROM subagent_defs WHERE name = ?")
      .run(name);
    return res.changes > 0;
  }
}
