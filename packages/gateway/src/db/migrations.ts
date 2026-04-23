import type { Database as DatabaseHandle } from "better-sqlite3";

/**
 * Migrations are append-only. Never edit an existing one — add a new one.
 * Each migration has a monotonic id. The `schema_version` table records
 * what has already run.
 */
interface Migration {
  id: number;
  name: string;
  up: string;
}

const migrations: Migration[] = [
  {
    id: 1,
    name: "initial",
    up: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT REFERENCES sessions(id),
        subagent_def_id TEXT,
        title TEXT,
        platform TEXT,
        remote_id TEXT,
        model TEXT NOT NULL,
        system_prompt_hash TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
      CREATE INDEX idx_sessions_remote ON sessions(platform, remote_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_messages_session ON messages(session_id, created_at);

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        content='',
        tokenize='porter unicode61'
      );

      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT REFERENCES messages(id),
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tool_calls_session ON tool_calls(session_id, created_at);
      CREATE INDEX idx_tool_calls_run ON tool_calls(run_id);
    `,
  },
  {
    id: 2,
    name: "tasks",
    up: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        task_list_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        active_form TEXT,
        owner TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        blocks_json TEXT NOT NULL DEFAULT '[]',
        blocked_by_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_list ON tasks(task_list_id, created_at);
      CREATE INDEX idx_tasks_status ON tasks(task_list_id, status);
    `,
  },
];

export function runMigrations(db: DatabaseHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT id FROM schema_version").all() as Array<{ id: number }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_version (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    tx();
  }
}

export { migrations };
