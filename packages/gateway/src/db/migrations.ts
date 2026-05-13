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
  {
    id: 3,
    name: "questions",
    up: `
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        asked_by TEXT NOT NULL,
        input_json TEXT NOT NULL,
        answers_json TEXT,
        annotations_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        asked_at TEXT NOT NULL,
        answered_at TEXT,
        timed_out_at TEXT
      );

      CREATE INDEX idx_questions_session ON questions(session_id, asked_at);
      CREATE INDEX idx_questions_status ON questions(status);
    `,
  },
  {
    id: 4,
    name: "subagent_defs",
    up: `
      CREATE TABLE subagent_defs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        version TEXT NOT NULL,
        config_json TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 5,
    name: "session_delivery_mode",
    up: `
      ALTER TABLE sessions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'interrupt';
    `,
  },
  {
    id: 6,
    name: "session_fallbacks",
    up: `
      ALTER TABLE sessions ADD COLUMN fallbacks_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 7,
    name: "session_compact_flag",
    up: `
      ALTER TABLE sessions ADD COLUMN compact_at_start INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 8,
    name: "memory",
    up: `
      CREATE TABLE memory_entry (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_key TEXT,
        file_path TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        confidence INTEGER NOT NULL DEFAULT 50,
        provenance_session_id TEXT,
        provenance_agent_id TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_memory_type_status ON memory_entry(type, status);
      CREATE INDEX idx_memory_scope ON memory_entry(scope, scope_key, status);
      CREATE INDEX idx_memory_last_used ON memory_entry(last_used_at);
      CREATE UNIQUE INDEX idx_memory_file_path ON memory_entry(file_path);

      CREATE VIRTUAL TABLE memory_entry_fts USING fts5(
        id UNINDEXED, name, description, body,
        tokenize='porter unicode61'
      );

      CREATE TABLE memory_history (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        body TEXT NOT NULL,
        description TEXT NOT NULL,
        reason TEXT,
        changed_by_agent_id TEXT,
        changed_at TEXT NOT NULL
      );

      CREATE INDEX idx_memory_history_entry ON memory_history(entry_id, changed_at);
    `,
  },
  {
    id: 9,
    name: "drop_local_memory_tables",
    up: `
      DROP TABLE IF EXISTS memory_history;
      DROP TABLE IF EXISTS memory_entry_fts;
      DROP TABLE IF EXISTS memory_entry;
    `,
  },
  {
    id: 10,
    name: "session_ingest",
    up: `
      ALTER TABLE sessions ADD COLUMN ingest_watermark_message_id TEXT;
      ALTER TABLE sessions ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE sessions ADD COLUMN ingest_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN ingest_last_error TEXT;
      ALTER TABLE sessions ADD COLUMN ingest_chunks_processed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN ingest_last_run_at TEXT;
      ALTER TABLE sessions ADD COLUMN ingestable INTEGER NOT NULL DEFAULT 1;

      CREATE INDEX idx_sessions_ingest_status ON sessions(ingest_status);
    `,
  },
  {
    id: 11,
    name: "session_title_model",
    up: `
      ALTER TABLE sessions ADD COLUMN title_model TEXT;
    `,
  },
  {
    id: 12,
    name: "messages_fts_with_content",
    up: `
      DROP TABLE IF EXISTS messages_fts;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        tokenize='porter unicode61'
      );

      INSERT INTO messages_fts (rowid, text)
      SELECT m.rowid, COALESCE(
        (SELECT group_concat(json_extract(value, '$.text'), ' ')
         FROM json_each(m.content_json)
         WHERE json_extract(value, '$.type') = 'text'),
        ''
      )
      FROM messages m;
    `,
  },
  {
    // Lets us correlate persisted tool_calls rows to the LLM-side tool_use
    // block id that triggered them. Needed so the dashboard can dedup
    // tool_calls fetched on session load against tool_use blocks already
    // rendered from persisted messages — and so claude-cli's tool calls
    // (which never appear as tool_use blocks in any message, because the
    // CLI runs its own internal loop) can still be rendered after refresh
    // by looking them up here. Nullable: legacy rows from before this
    // migration have no LLM-side id.
    id: 13,
    name: "tool_calls_llm_use_id",
    up: `
      ALTER TABLE tool_calls ADD COLUMN llm_tool_use_id TEXT;
      CREATE INDEX idx_tool_calls_llm_use_id ON tool_calls(llm_tool_use_id);
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
