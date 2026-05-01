# Storage and memory

Two independent layers:

1. **Gateway-owned SQLite** — sessions, messages, tool calls, tasks,
   questions, subagent defs. The single source of truth for what happened.
2. **MemCore** — a separate, typed memory store the agent reads and writes
   through tools. Backs the per-turn memory blocks in your prompt.

## SQLite — what tables exist

Append-only migrations in `packages/gateway/src/db/migrations.ts`. Live
schema highlights (per migration as of writing):

| Table              | What it holds                                                                 |
|--------------------|-------------------------------------------------------------------------------|
| `sessions`         | `id`, `parent_session_id`, `subagent_def_id`, `title`, `platform`, `remote_id`, `model`, `status`, `tokens_in/out`, `delivery_mode`, `fallbacks_json`, `compact_at_start`, `ingest_*` columns, `title_model`, `created_at`, `updated_at` |
| `messages`         | `id`, `session_id`, `role`, `content_json`, `created_at` — backed by FTS5 `messages_fts(text)` (with content) |
| `tool_calls`       | `id`, `session_id`, `message_id`, `run_id`, `name`, `input_json`, `result_json`, `is_error`, `status`, `created_at` |
| `tasks`            | `id`, `task_list_id`, `subject`, `description`, `active_form`, `owner`, `status`, `blocks_json`, `blocked_by_json`, `metadata_json`, timestamps |
| `questions`        | `id`, `session_id`, `asked_by`, `input_json`, `answers_json`, `annotations_json`, `status`, `asked_at`, `answered_at`, `timed_out_at` |
| `subagent_defs`    | `id`, `name`, `version`, `config_json`, `registered_at` — cached defs so the tree view can resolve names after a plugin unload |
| `schema_version`   | applied migrations                                                            |

A few tables you might expect (`approvals`, `routines`, `plugins`, `tokens`)
exist but live in their own paths via dedicated stores; check
`packages/gateway/src/{approvals,routines}/store.ts` etc. for their
canonical shapes.

### Soft deletes

`tasks.status='deleted'` and `messages` are append-only. Don't hard-delete
historical rows — the transcript needs to stay coherent for FTS5 search.

### One file, single writer

The gateway holds an open SQLite handle (`better-sqlite3` or `bun:sqlite`).
Backups = copy the file. Writes are serialised inside the process.

## MemCore — typed memory

Separate package. Source-of-truth for cross-session memory entries.

### Entry types (mirrors the agent-side memory taxonomy)

- `user` — what you know about the human (role, preferences, knowledge).
- `feedback` — corrections / confirmations they've given you.
- `project` — facts / decisions / state about ongoing work.
- `reference` — pointers to external systems (Linear, dashboards, …).

### How it surfaces in your prompt

Per-turn (`packages/gateway/src/runs.ts`):

- **Eager block** — frozen at session start. `user` + `feedback` entries —
  things you should always have. Frozen so the prompt prefix stays cacheable.
- **Retrieval block** — per-turn FTS over `project` + `reference` entries
  scoped to the session-tree root.

### How you mutate it

Through the `memory` tool group (lazy — call `describe_tool_group({ groups:
"memory" })` first). Tools cover propose / update / archive / search. Don't
write to memory files directly on disk.

### Source

- Service: `packages/gateway/src/memory/service.ts`
- Session ingestion (turn → memory): `packages/gateway/src/memory/session-ingest.ts`
- LLM router for memory extraction: `packages/gateway/src/memory/llm-router.ts`
- Embedder resolution: `packages/gateway/src/memory/embedder-resolver.ts`
- Tools: `packages/tools/src/memory/`

## Workspace + core files (`.squad/`)

Separate from MemCore. Three files in `<workspace>/.squad/` are loaded into
your prompt on every turn:

| File         | What it is                                                            |
|--------------|-----------------------------------------------------------------------|
| `SOUL.md`    | Identity, defaults, taste. Edit when *who you are* changes.           |
| `USER.md`    | What you know about the human. Edit when you learn something durable. |
| `MEMORY.md`  | Index of everything else worth keeping. Add lines pointing to deeper files under `.squad/<topic>.md`. |

Seeded once (idempotently) by `agent-prompt.ts/seedCoreFiles`. Kept short —
every line is paid every turn. Push detail into linked `.squad/<topic>.md`
files.

Subagents have their own core dir at `<workspace>/.squad/subagents/<name>/`
(`subagentCoreDir`).

## Why memory goes in the user message, not system

A historical detail worth knowing: per-turn retrieval is appended to the
**user** message, not the system prompt. This preserves Anthropic's prompt
cache hit on the system prefix across turns. The eager block stays in the
system prompt because it's frozen at session start.

## Source map

- Migrations: `packages/gateway/src/db/migrations.ts`
- DB handle: `packages/gateway/src/db/index.ts`
- Per-table stores: `packages/gateway/src/db/{sessions,messages,tool-calls,subagent-defs}.ts`
- Memory: `packages/gateway/src/memory/`
- Memory tools: `packages/tools/src/memory/`
- Core files seed/load: `packages/gateway/src/agent-prompt.ts`
