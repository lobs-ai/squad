# Memory Subsystem

Typed, persistent memory for Squad agents. This is the design for the structured memory store — distinct from the static `SOUL.md` / `USER.md` / `MEMORY.md` core files in `<workspace>/.squad/`, which remain as identity and onboarding scaffolding.

## Why

We surveyed two existing systems: hermes-agent (two curated markdown files, eager-loaded, character-capped, no retrieval) and openclaw (markdown + SQLite + vector embeddings, hybrid FTS+vector retrieval, automatic flush, many tuning knobs). Each has clear weaknesses:

- **Hermes** wastes context (every entry every turn), has no temporal awareness, one undifferentiated pool, brittle substring-edit semantics, no curation surface.
- **OpenClaw** has lock contention, embedding cold-start, no injection guardrails, silent auto-summarization, and high configuration surface.

Squad has SQLite+FTS5 already, a session-tree model, subagents, a plugin host, and a dashboard. The design here leans on those instead of importing OpenClaw's vector stack.

## Storage location

Memory lives at **`${HOME}/.squad/memory`** by default, overridable via `config.server.memory_dir`. Deliberately **not** under the docker bind-mount, the workspace, or `data_dir`:

- The agent's workspace (`<workspace>/.squad/`) is per-deployment scratch.
- `data_dir` is gateway operational state (sqlite, queues).
- Memory is durable, user-curated, portable. It outlives a single deployment and should follow the user across docker re-rolls.

Bind-mount it explicitly in docker if you want it there. Don't conflate it with state.

```
~/.squad/memory/
  MEMORY.md                  # human-readable index, one line per entry
  entries/
    user_role.md             # frontmatter + body, one file per entry
    feedback_testing.md
    project_auth_freeze.md
    reference_grafana.md
```

The SQLite index lives **inside the gateway DB** (a few extra tables, see Schema). Files on disk are the source of truth; the DB is a derived index that can be rebuilt by re-reading the directory.

## Entry types

Five types, each with different retrieval and decay defaults. This is the load-bearing distinction Hermes and OpenClaw both lack.

| Type | Eager-loaded? | Decay | Default scope |
|---|---|---|---|
| `user` | yes | never | global |
| `feedback` | yes | never (sticky rules) | global or project |
| `project` | retrieved | 30d unless re-confirmed | project |
| `reference` | retrieved | only on 404 | project |
| `working` | tree-only, dies with tree | n/a | tree |

`working` entries are scratchpad shared among the parent + subagents during one run; everything else persists.

## Scope

Memories carry a `scope` field that uses Squad's session tree:

- `tree` — visible to one parent + its subagents, dies with the tree
- `project` — persistent within a workspace
- `global` — user-level (default for `user` and `feedback`)

Subagents see project + global memory and inherit any tree-scoped memory their parent created. Writes carry provenance (which session, which agent, which turn).

## Hybrid eager + retrieved

The system prompt has two memory blocks:

1. **Eager block** — all `user` and `feedback` entries, capped at ~3 KB total, **frozen at session start**. Goes inside the cacheable system-prompt prefix. (Steal Hermes's best idea: don't perturb the prefix cache mid-session.)
2. **Retrieval block** — per-turn FTS5 search over `project` + `reference` entries, scored against the user message and active task description. Top-k with score floor, injected after the cache boundary so it busts only the dynamic suffix.

No vector embeddings in v1. FTS5 is built into SQLite, already in the gateway, and adequate at single-user scale. Vectors land later as a plugin if recall actually suffers — don't pay the embedding tax up front.

## Write path

One tool: `memory_propose`. Path: agent → tool → store.

1. Validate frontmatter and char budget per type.
2. Run prompt-injection scan over the body.
3. FTS-search for near-duplicates; if found, surface them and recommend `memory_update` instead.
4. Write the markdown file. Re-read it to populate FTS5 (so on-disk content is canonical).
5. Append a `memory_history` row capturing the write. Returns the new id.

Edits go through `memory_update` by id (no substring matching — that's Hermes's bug). Soft-deletes go through `memory_archive` (status = `archived`); archived entries stay FTS-searchable but never eager-loaded. This is salience-based eviction without a hard char cap.

Writes are file-first, index-second: no DB-side write contention, and the markdown directory is git-friendly if the user wants to back it up.

## Schema (migration 8)

```sql
CREATE TABLE memory_entry (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                     -- user|feedback|project|reference|working
  name TEXT NOT NULL,
  description TEXT NOT NULL,              -- one-line hook used in the index
  scope TEXT NOT NULL,                    -- global|project|tree
  scope_key TEXT,                         -- project key or session-tree root id
  file_path TEXT NOT NULL,                -- absolute path inside memory_dir
  body TEXT NOT NULL,                     -- last-known body (re-derivable from file)
  status TEXT NOT NULL DEFAULT 'active',  -- active|archived
  confidence INTEGER NOT NULL DEFAULT 50, -- 0-100
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

CREATE VIRTUAL TABLE memory_entry_fts USING fts5(
  name, description, body,
  content='memory_entry', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TABLE memory_history (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  body TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT,                            -- 'create'|'update'|'archive'
  changed_by_agent_id TEXT,
  changed_at TEXT NOT NULL
);

CREATE INDEX idx_memory_history_entry ON memory_history(entry_id, changed_at);
```

History rows are append-only. Conflict resolution: higher confidence wins; the loser becomes a history row, never deleted.

## Tools the agent gets

- `memory_propose({type, scope, name, description, body, confidence?})` — create new entry; rejects exact duplicates, surfaces near-duplicates.
- `memory_update({id, body?, description?, confidence?})` — overwrite; old version goes to history.
- `memory_archive({id, reason?})` — soft delete; keeps FTS row but drops from eager block.
- `memory_search({query, types?, scopes?, limit?})` — FTS5 query; updates `last_used_at` and `use_count`.
- `memory_list({type?, scope?, status?})` — list/inspect.

Tools are registered in the gateway just like task tools, so subagents inherit them automatically.

## Prompt integration

`buildSquadSystemPrompt` is extended with one new section, rendered after the existing core-files block:

```
## Persistent memory

You have a typed, retrievable memory store at ~/.squad/memory/.
Save with memory_propose, refine with memory_update, retrieve with memory_search.
Types: user (about the human), feedback (rules to keep applying),
project (workspace facts), reference (pointers), working (this run only).
```

Then the **eager block** is appended (frozen for the session), followed by the **retrieval block** (recomputed per turn, after the cache boundary).

## Out of scope for v1

- Embeddings / vector search (FTS5 only).
- Auto-summarization of old turns into memory (OpenClaw's most error-prone behavior).
- Multimodal memory.
- Cross-user sharing.
- A dashboard pane (planned, not blocking).

## Why this is better

- vs **Hermes**: typed lifecycles, retrieval for the long tail, scope-aware for subagents, id-based edits, soft-delete history, salience tracking.
- vs **OpenClaw**: no embedding stack to operate, no DB write contention (file-first), injection guardrails, transparent files the user can read and edit, no silent auto-summarization.
- vs **both**: tree-scope leverages Squad's actual architecture instead of treating memory as one global blob.
