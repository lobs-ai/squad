# Squad — Design Specification

## Overview

Squad is a self-hostable agent platform that competes on two things: **usability** and **subagents**. Everything else in the design serves one of those two.

The four load-bearing primitives:

1. **Subagents.** A parent agent can spawn workers with their own model, tools, system prompt, and token budget; they run in parallel, stream progress back through the same protocol, and every run is its own searchable session. Subagent definitions are plugins — ship a `code-reviewer` or `researcher` once, any agent can call it.
2. **Tasks.** A first-class, session-tree-scoped task list. Agents create tasks, claim them, mark them `in_progress` / `completed`, express dependencies, and see each other's progress. Users see the same list. In a multi-subagent run, the task list is the shared plan of record.
3. **Ask-user questions.** Structured multiple-choice questions with channel-native rendering: Discord buttons, dashboard cards, CLI select-lists, SMS keyword replies. An agent asking a clarifying question is one tool call, not a free-text paragraph the user has to parse and answer correctly. This is the single biggest usability win a channel-agnostic platform can ship.
4. **The protocol is the product.** Every client of the gateway — Discord, dashboard, CLI, a third-party UI, another channel — speaks the same WebSocket wire. Tasks, ask-user questions, and subagent trees are protocol primitives, so every client gets a consistent rendering story for free. None of them is privileged.

And one supporting discipline: **vendored, not imported.** `packages/runner` and `packages/llm` are copied from [`lobs/agentic`](../agentic) with pinned source commits in `VENDOR.md`. Upstream velocity can't break Squad; re-sync is a deliberate act.

The design target for v1 is **stability and focus**: one shipped channel to start (Discord), one storage engine (SQLite), one deployment story (a single Docker Compose service). For LLMs we ship every provider the vendored agent loop supports out of the box — native Anthropic, native OpenAI, and ~24 OpenAI-compatible endpoints through one shared client — so users aren't locked to a single model vendor on day one. Anything beyond this core — additional channels, tools, skills, scheduled routines, new providers, reusable subagent definitions — is a plugin.

**Influences and distinctions.** Squad borrows the gateway/plugin/broadcast pattern from OpenClaw and the session-persistence patterns from hermes-agent. Where we differ: OpenClaw's dashboard is privileged; Squad's dashboard is symmetric with every other client. Hermes's headline features are a closed learning loop and a terminal-first UX; Squad's headline features are the subagent primitive, the task primitive, and the ask-user primitive — all rendered natively per channel. We don't try to out-channel OpenClaw or out-learn hermes. We try to be the platform where an agent working across Discord, the dashboard, and a CLI feels native on each one.

---

## Design Principles

1. **One process, one deploy.** The gateway runs the agent loop — and by default the Discord channel — in-process. A single `docker compose up` stands up the whole stack. Channel plugins can be moved to their own container when scale or isolation demands it, but that's opt-in.
2. **Any channel, any time.** The gateway is channel-agnostic. Discord, Slack, Telegram, SMS, email, voice, webhooks, IDE plugins — they all implement the same **channel** contract. Squad ships Discord as the reference channel; the rest are plugins.
3. **Plugins are the extension story.** Tools, LLM providers, channels, skills, routines, and **subagent definitions** are all plugins with a single, uniform entry contract.
4. **The dashboard is not privileged.** It connects to the gateway over WebSocket using the same protocol as every channel. If the dashboard can do something, a third-party client can too.
5. **Subagents, tasks, and ask-user are primitives, not tools bolted on.** They have their own protocol namespaces, their own storage, their own rendering contract per channel. A new channel implements tasks and questions by describing how it wants to render them; a new agent gets them for free.
6. **Usability lives in the channel.** The gateway emits *structured intent* (a question with options, a task update, a subagent spawn). The channel turns it into *native UX* (Discord buttons, a Slack block, a dashboard card, a CLI select prompt). Agents never hand-roll channel-specific markup.
7. **Vendor the agent loop.** `packages/runner` and `packages/llm` are copied from agentic with commit SHAs pinned in `VENDOR.md`. Squad owns them outright and re-syncs deliberately.
8. **Self-host by default.** No telemetry, no hosted backend, no cloud-only features. Your data, your channels, your machine.

---

## Architecture

```
┌─────────────────────┐        ┌────────────────────────────────────────────┐
│ Channel: Discord*   │───WS──▶│                                            │
│ Channel: Slack      │───WS──▶│                  Gateway                   │
│ Channel: CLI        │───WS──▶│                                            │
│ Channel: …          │───WS──▶│  ┌─────────────┐  ┌─────────────────────┐  │
└─────────────────────┘        │  │  Dispatch   │  │    Plugin Host      │  │
┌─────────────────────┐        │  │ (namespaced │  │ (load, init, hook,  │  │
│   Web Dashboard     │───WS──▶│  │  handlers)  │  │  unload, subagents) │  │
│   (React + Vite)    │◀──WS───│  └──────┬──────┘  └──────────┬──────────┘  │
└─────────────────────┘        │         │                    │             │
┌─────────────────────┐        │  ┌──────▼────────────────────▼──────────┐  │
│  Your third-party   │───WS──▶│  │         Runner (agent loop)          │  │
│    client / UI      │        │  │   runAgent() ⇒ LLM + tool calls      │  │
└─────────────────────┘        │  └──────┬────────────────────┬──────────┘  │
                               │         │                    │             │
                               │  ┌──────▼──────┐     ┌───────▼──────────┐  │
                               │  │ LLM clients │     │  Tools + spawn_  │  │
                               │  │ (27 provs)  │     │  subagent        │  │
                               │  └─────────────┘     └────────┬─────────┘  │
                               │                               │             │
                               │                     ┌─────────▼──────────┐  │
                               │                     │  Subagent pool     │  │
                               │                     │  (parallel workers,│  │
                               │                     │   own sessions)    │  │
                               │                     └─────────┬──────────┘  │
                               │                               │             │
                               │  ┌──────────────┐    ┌────────▼──────────┐  │
                               │  │ Task store   │    │ Question store    │  │
                               │  │ (per session │    │ (pending asks,    │  │
                               │  │  tree, deps) │    │  channel-rendered)│  │
                               │  └──────┬───────┘    └─────────┬─────────┘  │
                               │         │                      │            │
                               │  ┌──────▼──────────────────────▼─────────┐  │
                               │  │ SQLite (sessions, subagents, tasks,   │  │
                               │  │ questions, approvals, routines, FTS5) │  │
                               │  └───────────────────────────────────────┘  │
                               └────────────────────────────────────────────┘

                     * Discord ships in-process by default.
                       Out-of-process is a supported opt-in.
```

Channels, the dashboard, and any third-party client are all **equal clients** of the gateway. They open a WebSocket, authenticate, subscribe to the scopes they care about, and send/receive the same JSON messages. The gateway runs the agent loop in-process and streams results back to whichever clients asked for them — including subagent runs, which live on their own topics. The gateway never needs to know *which* kind of client it's talking to — only that the other side speaks the protocol.

---

## Packages

```
squad/
├── packages/
│   ├── gateway/            # HTTP + WS server, dispatch, plugin host, storage, subagent pool,
│   │                       # task store, question store
│   ├── runner/             # Agent loop (vendored from agentic)
│   ├── llm/                # LLMClient interface + provider implementations (vendored)
│   ├── tools/              # BaseTool, ToolRegistry, built-in tools:
│   │                       # spawn_subagent, create_task, update_task, list_tasks, ask_user
│   ├── protocol/           # Wire types + Zod schemas (includes subagents.*, tasks.*, questions.*)
│   ├── plugin-sdk/         # definePlugin() contract, types for extension authors
│   ├── channel-sdk/        # Shared runtime for channel processes (WS client, retry, session mapping)
│   │                       # + the renderer contract each channel implements for tasks + questions
│   ├── channel-discord/    # First-party Discord channel (in-process by default, standalone supported)
│   ├── client-cli/         # Reference terminal client — proves any client can be built on the protocol
│   └── dashboard/          # React + Vite web UI
├── extensions/             # User-authored plugins (tools, channels, providers, subagents...)
├── examples/
│   ├── compose.yml                  # default: one service, Discord in-process
│   ├── compose.split-channels.yml   # opt-in: gateway + discord as separate services
│   ├── config.json
│   └── subagents/                   # starter subagent definitions (code-reviewer, researcher)
├── VENDOR.md               # source commit SHAs for files copied from lobs/agentic
└── docs/
```

### `@squad/gateway`

The long-running server. Responsibilities:

- HTTP surface: health, `/auth`, static dashboard assets, REST for admin ops (optional).
- WebSocket surface: the wire protocol — every client connects here.
- **Dispatch**: namespaced RPC handlers (`session.*`, `chat.*`, `subagents.*`, `tasks.*`, `questions.*`, `plugins.*`, `routines.*`, `approvals.*`, `admin.*`). New namespaces go in `gateway/src/dispatch/<namespace>.ts`.
- **Broadcast**: event stream with scoped subscriptions. Clients subscribe to e.g. `chat.*` for a specific session, `subagents.*` for a parent session's worker tree, `tasks.*` for the task list, `questions.*` for pending asks. The gateway only delivers what their token authorizes.
- **Plugin host**: discovers plugins on startup, calls each plugin's `register()` with a `GatewayAPI` handle, tears them down cleanly on shutdown/reload.
- **Agent execution**: wraps `runAgent()` from `@squad/runner`. Each incoming user message produces a run; streaming text and tool activity broadcast as events.
- **Subagent pool**: owns the lifecycle of spawned subagents — bounded concurrency, bounded depth, token budget enforcement, cancellation propagation from parent to children. See the [Subagents](#subagents) section.
- **Task store**: owns the task list for each session tree. Handles dependencies, high-water-mark IDs, serialized writes under a lock so concurrent subagents can claim tasks safely. See the [Tasks](#tasks) section.
- **Question store**: holds pending ask-user questions, keyed by session and correlation id. Resolves when any authorized channel or client submits an answer; times out under policy. See the [Ask-User Questions](#ask-user-questions) section.
- **Storage**: a single SQLite database (via `better-sqlite3` or `bun:sqlite`) for sessions, messages, tasks, questions, approvals, routines, and transcripts. FTS5 for session search (parents and subagents alike).

### `@squad/runner` *(vendored from agentic)*

Copy these files from `/Users/rafe/other/lobs/agentic/packages/runner/src/`:

- `agent-loop.ts` — the core loop: build system prompt, call LLM, parse tool-use blocks, execute in parallel, append results, repeat until `end_turn` or limits hit.
- `types.ts` — `AgentSpec`, `AgentResult`, `ToolResult`, timeouts, token accounting.
- `hooks.ts` — `before_agent_start`, `before/after_llm_call`, `before/after_tool_call`, `after_agent_end`. The gateway registers hooks for logging, approval gating, and event broadcasting.
- `context-engine.ts` — pluggable context compaction.
- `loop-detector.ts` — flags repetitive tool calls so the model can recover.

We drop agentic's `session.ts` (we use our own SQLite session store) and any runner-layer config discovery.

### `@squad/llm` *(vendored from agentic)*

- `types.ts` — `LLMClient`, `LLMMessage`, `LLMResponse`, `ContentBlock`, `ToolDefinition`.
- `client.ts` — `parseModelString()`, `inferProvider()`, `createClient()`. Accepts either `"provider/model-id"` or a bare model id that maps to a provider via well-known prefixes (`claude-*` → anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → openai, `gemini-*` → google, `deepseek-*` → deepseek, `mistral-*` / `mixtral-*` / `codestral-*` → mistral, `llama-*` / `gemma-*` / `qwen-*` → groq, `grok-*` → xai, `sonar-*` / `r1-*` → perplexity, `command-*` / `embed-*` → cohere, `ollama:*` → ollama).
- `providers/anthropic.ts` — native Anthropic SDK.
- `providers/openai.ts` — native OpenAI SDK (also serves `openai-codex`).
- `providers/openai-compatible.ts` — shared OpenAI-compatible client used for every other provider below.

**All providers ship in v1** (same list agentic supports):

| Category            | Providers                                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------------------------|
| Native SDK          | `anthropic`, `openai`, `openai-codex`                                                                           |
| Cloud aggregator    | `openrouter`                                                                                                    |
| Frontier labs       | `deepseek`, `mistral`, `groq`, `together`, `xai`, `perplexity`, `fireworks`, `cerebras`, `cohere`               |
| Google              | `google`                                                                                                        |
| Scale/edge          | `sambanova`, `novita`, `hyperbolic`, `lambda`                                                                   |
| Local / self-hosted | `ollama`, `lmstudio`, `llamacpp`, `vllm`                                                                        |
| Other               | `z-ai`, `minimax`, `kimi`, `opencode-zen`, `opencode-go`                                                        |
| Escape hatch        | `openai-compatible` (requires a `baseUrl` in config — works against any OpenAI-compatible endpoint)             |

Local providers (`ollama`, `lmstudio`, `llamacpp`, `vllm`) don't require an API key. Every other provider reads `<PROVIDER>_API_KEY` from the environment unless overridden in `config.json`.

**Default model** is Anthropic (`claude-sonnet-4-6`), but any installed provider is usable per-session. Sessions, routines, and plugins can specify their own model string. Further providers (a brand-new vendor, a custom fine-tuned endpoint with special auth, etc.) still come as plugins that register an additional `LLMClient`.

### `@squad/tools`

- `base-tool.ts` + `registry.ts` — vendored from agentic.
- A minimal built-in set: `read_file`, `write_file`, `list_directory`, `web_search` (if a search API key is configured), `fetch_url`. Everything else ships as a plugin.
- Tools can declare `tags: ["readonly" | "write" | "exec" | "network"]`. The gateway uses tags to drive the approval policy.

### `@squad/protocol`

Shared TypeScript types + Zod schemas for every wire message. The gateway, the Discord connector, and the dashboard all depend on this package — nothing else. If a new message type doesn't have a schema here, it doesn't exist.

### `@squad/plugin-sdk`

The public contract for plugin authors.

```ts
import { definePlugin } from "@squad/plugin-sdk";

export default definePlugin({
  id: "my-cool-tool",
  name: "My Cool Tool",
  version: "0.1.0",
  kinds: ["tool"],
  register(api) {
    api.tools.register(new MyCoolTool());
    api.hooks.on("after_tool_call", ({ toolName }) => {
      api.logger.info(`ran ${toolName}`);
    });
    return () => { /* optional cleanup */ };
  },
});
```

Plugin kinds supported in v1:

| Kind       | What it registers                                                        |
|------------|--------------------------------------------------------------------------|
| `tool`     | New tools the agent can call                                             |
| `provider` | New `LLMClient` implementations                                          |
| `channel`  | New platform adapters (gives Discord no privilege)                       |
| `skill`    | Prompt snippets / memory injections                                      |
| `routine`  | Cron-scheduled agent runs                                                |
| `subagent` | A named, reusable subagent definition (model, tools, system prompt, budget) — callable by any agent via `spawn_subagent` |

A plugin can be any of these (or several) — `kinds` is an array.

### `@squad/channel-sdk`

A small library that every out-of-process channel depends on. Handles:

- WebSocket connect / auth / reconnect / backoff against the gateway.
- Session mapping: `(platform, remote_id) → session_id`, persisted to a local file so a restart doesn't orphan conversations.
- Event subscription helpers and typed wrappers over `@squad/protocol`.
- A `Channel` base class with the lifecycle hooks every channel implements:
  `connect()`, `onInboundMessage(msg)`, `sendOutbound(sessionId, content)`, `onApprovalRequest(req)`, `disconnect()`.

Community channels can either (a) be an out-of-process package that depends on `@squad/channel-sdk`, or (b) be an in-gateway plugin of kind `channel` — see the plugin kinds table below. The protocol is identical either way; the only difference is process boundary.

### `@squad/channel-discord`

The first-party Discord channel — see the [Discord Implementation Plan](#discord-implementation-plan) section for details. It is the reference implementation of a channel and the shape new channels should follow.

**By default Discord runs in-process** as a channel plugin, so `docker compose up` stands up the whole stack in one container. That matters more for first-run ergonomics than it looks: "run two containers so the bot can talk to the gateway" is a common place new users bounce off.

When isolation matters — multiple channels, an untrusted connector, or a bot that must be bounced independently — the same package runs as a standalone process via `@squad/channel-sdk`. The protocol is identical; only the process boundary changes. An `examples/compose.split-channels.yml` is provided for that path.

### `@squad/client-cli`

A reference terminal client that does nothing but speak the protocol: auth, subscribe, send `chat.send`, render streaming deltas. It exists to prove the symmetry claim — if it can be built on the protocol with no special gateway support, so can anything else. Contributors add a new client by copying its 300-ish lines and changing the render layer.

### `@squad/dashboard`

React + Vite. Served by the gateway (static assets) or run standalone during development.

Views:

- **Chat** — live conversation view per session, streaming assistant text, inline tool activity, images. Pending ask-user questions render inline as interactive cards.
- **Tasks** — the shared task list for the active session tree: dependency arrows, owner filter, spinner on the current `activeForm`, soft-delete history. Updates live off `tasks.*` subscriptions.
- **Sessions** — list/search (FTS5) across all sessions; tree view for parents with subagent children; jump to any transcript.
- **Approvals** — queue of pending tool-call approvals (anything tagged `write`/`exec`/`network` by policy). Approve/deny with reason.
- **Plugins** — installed list, status, reload/disable, per-plugin config.
- **Channels** — Discord channel routing, bot status, per-channel agent config, rendered capabilities.
- **Routines** — cron-scheduled runs; view next-fire times and last run output.
- **Logs** — gateway + plugin logs, filterable.
- **Settings** — models, API keys, storage location.

It talks to the gateway over WebSocket and does **nothing the protocol doesn't already expose** — so any third-party UI can do the same.

---

## Wire Protocol

Frames are JSON objects over WebSocket. Every frame has a `type` and an `id` (for request/response correlation).

### Frame types

```ts
// Request: client → gateway
{ type: "request", id: "<uuid>", method: "chat.send", params: { ... } }

// Response: gateway → client
{ type: "response", id: "<request-id>", ok: true, result: { ... } }
{ type: "response", id: "<request-id>", ok: false, error: { code, message } }

// Event: gateway → subscribed clients
{ type: "event", topic: "chat.assistant_message", data: { ... } }

// Subscribe / unsubscribe: client → gateway
{ type: "subscribe", id: "<uuid>", topics: ["chat.*/session-123"] }
```

### Methods (v1)

| Namespace     | Methods                                                                                   |
|---------------|-------------------------------------------------------------------------------------------|
| `session.*`   | `start`, `resume`, `end`, `list`, `search`                                                |
| `chat.*`      | `send` (user message), `stream` (server push), `history`                                  |
| `subagents.*` | `list` (registered definitions), `spawn`, `cancel`, `tree` (parent → children), `history` |
| `tasks.*`     | `create`, `update`, `get`, `list`, `delete` (by `status: "deleted"`), `claim`, `watch`    |
| `questions.*` | `ask`, `answer`, `cancel`, `list` (pending), `history`                                    |
| `approvals.*` | `list`, `decide`                                                                          |
| `plugins.*`   | `list`, `enable`, `disable`, `reload`, `configure`                                        |
| `channels.*`  | `list`, `bind` (channel → session routing), `unbind`, `capabilities` (what can it render) |
| `routines.*`  | `list`, `create`, `update`, `delete`, `run_now`                                           |
| `admin.*`     | `health`, `config`, `tokens.create`, `tokens.revoke`                                      |

### Events (v1)

Chat: `chat.user_message`, `chat.assistant_message`, `chat.text_delta`, `chat.tool_call`, `chat.tool_result`.
Subagents: `subagents.spawned`, `subagents.text_delta`, `subagents.tool_call`, `subagents.tool_result`, `subagents.completed`, `subagents.failed`.
Tasks: `tasks.created`, `tasks.updated` (status / owner / deps / metadata), `tasks.deleted`.
Questions: `questions.asked`, `questions.answered`, `questions.cancelled`, `questions.timed_out`.
Approvals: `approvals.pending`, `approvals.decided`.
Platform: `plugins.changed`, `routines.fired`, `log.line`.

All schemas live in `@squad/protocol` as Zod — validated on both sides.

---

## Sessions & Storage

**SQLite**, single file. Tables:

- `sessions(id, parent_session_id, subagent_def_id, title, platform, remote_id, model, created_at, updated_at, system_prompt_hash, status, tokens_in, tokens_out)`
  - `parent_session_id` is NULL for top-level sessions and set for subagent runs. A single table, one FTS5 index, one search surface for both.
  - `subagent_def_id` points at the registered subagent plugin that produced this run (NULL for user-initiated sessions).
- `messages(id, session_id, role, content_json, created_at)` with FTS5 index on extracted text
- `tool_calls(id, session_id, message_id, name, input_json, result_json, status, created_at)`
- `approvals(id, session_id, tool_call_id, decision, reason, decided_by, decided_at)`
- `routines(id, name, cron, prompt, model, delivery_json, enabled, last_run_at, next_run_at)`
- `subagent_defs(id, name, version, config_json, registered_at)` — cache of what's been registered, so the tree view can resolve names even after a plugin unload.
- `tasks(id, task_list_id, subject, description, active_form, owner, status, blocks_json, blocked_by_json, metadata_json, created_at, updated_at)`
  - `task_list_id` is derived from the session tree root (every subagent in a tree shares one list).
  - `status ∈ {'pending', 'in_progress', 'completed', 'deleted'}`. Deletes are soft so the transcript remains coherent.
  - Writes are serialized under a per-list lock so concurrent subagents claiming tasks don't clobber each other.
- `questions(id, session_id, header, question, options_json, multi_select, status, answer_json, annotations_json, asked_by, asked_at, answered_at, timed_out_at)`
  - `status ∈ {'pending', 'answered', 'cancelled', 'timed_out'}`. One row per ask; answers are append-only (a cancelled + re-asked question is two rows).
- `plugins(id, version, enabled, config_json, installed_at)`
- `tokens(id, label, hash, scopes_json, created_at, revoked_at)`

The gateway holds an open handle; writes are serialized. Backups are "copy the file". This is fine for the scale this project targets (one user, one Discord, one dashboard, a handful of concurrent conversations plus their subagent trees).

**Memory is injected into the user message, not the system prompt** — this preserves Anthropic prompt caching of the system prefix across turns (pattern borrowed from hermes-agent).

---

## Plugins — Authoring & Loading

A plugin is an npm package (or a local directory) with this shape:

```
my-plugin/
├── package.json
│   └── "squad": { "entry": "./dist/index.js" }
├── src/
│   └── index.ts   → default export: definePlugin({...})
└── README.md
```

On startup the gateway:

1. Reads `extensions/` and any paths in `config.json`'s `plugins` list.
2. For each, dynamically `import()`s the entry, gets the default export, validates it.
3. Calls `plugin.register(api)` with a scoped `GatewayAPI`:
   - `api.tools.register(tool)`
   - `api.providers.register(name, client)`
   - `api.channels.register(adapter)`
   - `api.skills.register(skill)`
   - `api.routines.register(routine)`
   - `api.delivery.register(kind, handler, meta?)` — routine delivery fan-out
   - `api.promptFragments.register(fragment)` — conditional extensions to
     built-in tool descriptions; `slot` is one of `PROMPT_SLOTS.*`,
     optional `when(render, ctx)` predicate gates on the per-turn render
     context (channel, surface, capabilities). Fragments are removed
     automatically on plugin unload — live updates without restart.
   - `api.hooks.on(event, handler)` — subscribe to runner hooks
   - `api.logger` / `api.config` / `api.storage` — scoped helpers
4. Stores the returned cleanup function (if any) for `plugins.disable` / `plugins.reload`.

Plugins are **not sandboxed**. The assumption is you're self-hosting and you trust what you install — same model as OpenClaw. Sandboxing can come later if there's ever a marketplace.

---

## Tasks

A task list is the shared plan of record for a session tree. Agents — parent and subagents alike — create tasks, claim them, mark them `in_progress` / `completed`, and express dependencies. Users see the same list in whatever client they're on. In a fan-out workflow, the task list is how the parent hands out work and watches it come back.

### Shape

```ts
type Task = {
  id: string;                 // assigned per task-list high-water mark
  subject: string;            // short imperative title ("Fix login redirect")
  description: string;        // full detail of what needs to be done
  activeForm?: string;        // present-continuous label for spinners ("Fixing login redirect")
  owner?: string;             // agent name (parent's session id, or a subagent name)
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  blocks: string[];           // task IDs this task blocks
  blockedBy: string[];        // task IDs that block this task
  metadata?: Record<string, unknown>;
};
```

### Tools agents call

| Tool              | Purpose                                                                    |
|-------------------|----------------------------------------------------------------------------|
| `create_task`     | Add a task. Returns the id. New tasks are `pending` with no owner.         |
| `update_task`     | Update status / subject / description / owner / dependencies / metadata.   |
| `list_tasks`      | Read the current list (ordered, pending + in-flight + recently completed). |
| `get_task`        | Fetch one task by id (useful after a stale-read).                          |

`update_task` is a single tool with multiple purposes on purpose — claiming a task (`owner: self`), starting work (`status: "in_progress"`), finishing (`status: "completed"`), soft-deleting (`status: "deleted"`), and linking dependencies (`addBlockedBy`, `addBlocks`) are all the same tool. Prompt discipline, not schema discipline, keeps agents honest.

### Guidance baked into the tool prompts

The `create_task` and `update_task` tool descriptions include normative guidance agents are expected to follow:

- Use tasks when work is multi-step (3+ distinct actions), complex, or explicitly requested.
- Skip tasks for trivial single-step work.
- Mark `in_progress` **before** starting work, not after.
- Mark `completed` only when the work is fully done — tests passing, implementation complete, no unresolved errors. On blockers, stay `in_progress` and create a new task describing what's needed.
- Discover a new dependency during work → add it with `addBlockedBy`, don't re-plan silently.
- On subagents: include enough detail in `description` that another agent could pick the task up cold. A subagent claims a task by setting `owner` via `update_task`.

This guidance lives in `packages/tools/src/tasks/*prompt.ts` and is part of the tool's system-prompt surface; agents see it when the tool is in their schema.

### Scope: the session tree

Tasks are scoped to a **session tree**, not a single session. When a subagent spawns, it inherits its parent's task list, so the parent can create a task and the subagent can claim and complete it. `task_list_id` resolves to the tree's root session id.

Concurrent writes (two subagents claiming tasks simultaneously) go through a per-list lock with retry backoff — a short critical section per mutation (read list → compute change → write) that scales cleanly to the handful of concurrent workers a session tree realistically has.

### Rendering

Task list state broadcasts as `tasks.*` events. Every client decides how to render:

- **Dashboard** — an expanded task panel with live status, dependency arrows, and a filter-by-owner toggle when subagents are active.
- **Discord** — a pinned embed for the active list, edited in place as tasks change; reactions to claim/complete.
- **CLI** — a compact checklist that reprints when the list changes, with the current in-progress task shown with a spinner using `activeForm`.
- **SMS** (post-v1) — summary line ("3 tasks, 1 in progress") with `TASKS` keyword to fetch details.

The renderer contract is part of `@squad/channel-sdk`: a channel that wants task support implements `renderTaskList(state)` and `handleTaskAction(action)` and gets the full experience without gateway changes.

### Subscriptions

- `tasks.watch?session=<tree_root_id>` streams every change to that tree's list.
- An agent that's just been asked to pick up work calls `list_tasks` once, then operates off the subscription — no polling.

### Why this matters

A shared task list is how multi-agent workflows stop being chaos. It gives the user a single view of "what is the agent planning and what has it done" that doesn't require reading the transcript. It gives subagents a way to coordinate without the parent mediating every step. It gives Squad a concrete, visible thing the competitors don't ship.

---

## Ask-User Questions

The single biggest usability gap in every chat-based agent: the agent needs input, asks a free-text question, the user types the wrong thing, the agent retries or proceeds on a bad assumption. We fix this with a first-class **ask-user** primitive that renders natively per channel.

### Shape

```ts
type AskQuestion = {
  header: string;        // very short chip label ("Auth method")
  question: string;      // the full question, ending in "?"
  options: Array<{
    label: string;       // short display (1–5 words)
    description: string; // what picking this means / trade-off
    preview?: string;    // optional content block — markdown or HTML snippet
                         // for mockups, code, config, diagram comparisons
  }>;
  multiSelect?: boolean; // default false
};

type AskInput = {
  questions: AskQuestion[];           // 1–4 questions, unique texts, 2–4 unique option labels each
  timeoutSeconds?: number;            // default from policy
  allowCustom?: boolean;              // default true — "Other" option always presented
};
```

### The tool

```ts
// ask_user tool — returns once the user answers or the question times out
{
  name: "ask_user",
  input: AskInput,
  output: {
    answers: Record<string /* question */, string /* chosen label or custom text */>;
    annotations?: Record<string, { preview?: string; notes?: string }>;
    status: "answered" | "timed_out" | "cancelled";
  }
}
```

Rules agents follow (in the tool prompt):

- Use it to clarify ambiguity, gather preferences, or offer a decision between concrete approaches — not to ask "are you sure?" or "should I proceed?".
- 2–4 options, mutually exclusive (unless `multiSelect`), ordered with the recommended choice first and labelled `(Recommended)`.
- Don't include a literal "Other" option — the channel always surfaces one.
- Use `preview` when the user would benefit from seeing a concrete artifact to compare (ASCII mockup, code snippet, config diff). Skip it for pure preference questions.

### Channel rendering

The ask-user primitive is where "usability lives in the channel" pays off. Channels receive a `questions.asked` event with the full `AskQuestion` array and decide how to render:

- **Dashboard** — a side-by-side card with options on the left; if any option has a `preview`, it renders in a monospace pane on the right. Free-text "Other" fallback. Submit button.
- **Discord** — each question becomes a message with up to 4 **buttons** (labels) plus a 5th "Other…" button that opens a modal for free-text. `multiSelect` becomes a select menu. If the question has previews, the bot posts the previews inline and the buttons below.
- **CLI** — an interactive `select` prompt; `preview` content renders above the option list when an option is focused. "Other" opens an editor prompt.
- **Slack** (post-v1) — Block Kit actions row; the same mapping as Discord.
- **SMS / Email** (post-v1) — reply with option number or keyword; "Other" is any non-matching text.

All channels share one answer shape, so the agent doesn't know or care which channel answered.

### Flow

1. Agent calls `ask_user` → gateway inserts a row in `questions`, broadcasts `questions.asked`, awaits an answer on the question's correlation id.
2. Every subscribed client renders the question in its native UI. Only the session's authorized clients can submit.
3. First valid submission wins. The gateway writes the answer, broadcasts `questions.answered`, and resolves the tool call.
4. On timeout or session end: `questions.timed_out` / `questions.cancelled`, and the tool returns a result the model sees.

### Channel capabilities

Not every channel supports every feature (`preview` in SMS is meaningless). A channel declares its capabilities via `channels.capabilities`:

```ts
{ supportsPreview: true, supportsMultiSelect: true, maxOptions: 4, supportsFreeText: true }
```

The gateway degrades gracefully: if a session's channel doesn't support previews, previews fall out of the wire for that channel (but still render for concurrent dashboard clients). If a channel caps options at 3 and the agent sent 4, the gateway rejects the tool call with a clear error so the agent can re-shape the question — we never silently drop an option.

### Why this matters

- It turns "type exactly the right thing" into "tap one button" — an order-of-magnitude improvement in UX on chat channels.
- It's a protocol-level feature, so every client gets a consistent model for free. Build an ask-user-aware UI once, use it everywhere.
- Nothing else in this space ships this. OpenClaw is channel-rich but treats asks as free text. Hermes is terminal-first and doesn't have a cross-channel structured-question primitive.

---

## Subagents

Subagents are the feature we expect Squad to be chosen for. OpenClaw and hermes-agent both support calling out to other agents in some form, but neither treats a subagent as a first-class primitive with its own session, its own topic, its own budget, a shared task list, and a reusable definition you install via the plugin system. We do.

### Shape

A **subagent definition** is a registered plugin value:

```ts
definePlugin({
  id: "code-reviewer",
  kinds: ["subagent"],
  register(api) {
    api.subagents.register({
      name: "code-reviewer",
      description: "Reviews a diff and reports issues with file:line references.",
      model: "claude-sonnet-4-6",              // can differ from parent
      tools: ["read_file", "list_directory"],  // narrower than parent by default
      systemPrompt: "You are a careful reviewer. Report concrete issues only.",
      inputSchema: z.object({ diff: z.string(), focus: z.array(z.string()).optional() }),
      limits: {
        maxTokens: 40_000,
        maxToolCalls: 50,
        timeoutMs: 120_000,
      },
    });
  },
});
```

Any agent can call it via the built-in `spawn_subagent` tool:

```json
{ "name": "spawn_subagent",
  "input": {
    "subagent": "code-reviewer",
    "input": { "diff": "...", "focus": ["packages/gateway"] },
    "wait": false
  }}
```

`wait: true` returns the final result inline as a tool result. `wait: false` returns a `sessionId` immediately, and the parent can poll or the caller can subscribe to `subagents.*/<sessionId>`. Either way, the parent can fan out — a planner asking five research subagents to work in parallel and then summarizing — without extra scaffolding.

### Execution

- Each spawn creates a row in `sessions` with `parent_session_id` set. Full transcript, searchable, resumable.
- Subagent runs broadcast on their own topics. The parent's `chat.*` stream is not cluttered with worker chatter; dashboards subscribe to `subagents.*/<parent_session>` to show the whole tree.
- The subagent pool bounds concurrency globally and per-parent (defaults: 8 global, 4 per parent), bounds tree depth (default: 3), and enforces per-subagent token and tool-call limits before execution rather than after.
- Cancellation propagates downward: cancel the parent → every in-flight descendant receives a cancellation and the tool result returns `status: "cancelled"`.
- Approvals follow the parent's policy by default; a subagent definition can **narrow** the policy (e.g. a `research` subagent with no `write` or `exec` tools available at all) but never widen it.
- **Task list is inherited.** Every subagent in a tree shares the root session's task list. A parent creates tasks, subagents claim them (`update_task {owner: self}`) and mark them complete. This is the coordination surface — not the parent's chat history.
- Models can differ. Classic split: an Opus parent delegates bulk reads to a Haiku research subagent. The parent pays for reasoning, the worker pays for throughput.

### Dashboard

The **Sessions** view renders any session with children as a tree. Clicking into a subagent shows its own transcript, tool calls, and token accounting — same UI as a top-level session, because it is one. FTS5 search hits subagent transcripts the same way it hits parent ones.

### Why this is the right bet

- It matches how real workflows decompose (research → draft → review).
- It's a protocol-level feature, so a CLI client, a dashboard, and a third-party UI all get subagent trees for free.
- It gives plugin authors a way to ship *capability*, not just tools: a `code-reviewer` plugin, a `researcher` plugin, a `data-analyst` plugin, each with its own model/tool/prompt tuning.
- It's the feature hermes-agent and OpenClaw most under-invest in, and the one we can most clearly lead on.

---

## Agent Loop — What We Vendor

The loop itself is unchanged from agentic. The gateway's job is to:

1. Build an `AgentSpec` from the session state:
   - `messages` — loaded from SQLite
   - `tools` — registry filtered by policy (approval-gated tools declared via tags)
   - `systemPrompt` — base prompt + plugin-contributed skills (cached)
   - `onTextChunk` — broadcast each delta as a `chat.text_delta` event
   - Hooks: `before_tool_call` (approval check), `after_tool_call` (persist + broadcast), `after_agent_end` (persist final message, mark session idle).
2. `await runAgent(spec)` on a worker (one per session). Runs are concurrent across sessions.
3. Persist messages/tool calls as they happen.

Approval flow:

- A tool tagged `write`/`exec`/`network` (when policy requires) hits `before_tool_call`.
- The hook consults the **policy engine** (see below), which may auto-approve, auto-deny, or escalate.
- On escalate, the hook inserts a row in `approvals`, broadcasts `approvals.pending`, and awaits a decision (with a timeout).
- The dashboard / Discord reaction triggers `approvals.decide`.
- On approve, the hook returns; the runner executes the tool. On deny, the hook returns an error `ToolResult` that the model sees.

### Policy engine

v1 ships a tags-only policy: any tool with a matching tag prompts for approval. That's the floor — but users quickly want things like "auto-approve `write_file` inside `./data`, deny outside" or "auto-approve `fetch_url` to `github.com`, escalate everything else." So the policy engine is a pluggable seam from day one:

```ts
export interface ApprovalPolicy {
  decide(ctx: {
    sessionId: string;
    parentSessionId: string | null; // non-null for subagent runs
    tool: ToolDefinition;           // includes tags
    input: unknown;                 // the tool's parsed input
    history: ToolCall[];            // prior calls in the session
  }): Promise<"approve" | "deny" | "escalate">;
}
```

- v1 ships `tag-match` (the default) and `allow-all` / `deny-all` for testing.
- Plugins of kind `tool` can ship an `ApprovalPolicy` alongside, so a `filesystem` plugin can register path-scoped rules and a `network` plugin can register host allowlists without new gateway code.
- Decisions cascade: first plugin policy to return a non-`escalate` wins; otherwise fall through to the default.
- Subagents inherit the parent's policy unless a subagent definition narrows it (remove a tag, remove a tool entirely).

The v1 UX is still "tags + approve/deny queue"; the policy engine's presence is what keeps v1.1 path-scoped rules from being a breaking change.

---

## Routines (scheduled agents)

Cron-scheduled runs, modeled on hermes' `cron/`:

- A routine is `{ cron, prompt, model, delivery }` stored in SQLite.
- A 60-second tick inside the gateway looks for due routines.
- Each due routine spawns an agent run in a fresh session (or a named persistent one).
- `delivery` decides where output goes: a Discord channel, a dashboard inbox, or `[SILENT]` (stored only).

Routines are a v1 feature because "run this every morning" is one of the highest-leverage things an agent platform can do, and it's cheap once the rest of the pieces exist.

---

## Configuration

`config.json`:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8080,
    "data_dir": "./data"
  },

  "auth": {
    "tokens": [
      { "label": "dashboard",          "key_env": "SQUAD_DASHBOARD_TOKEN", "scopes": ["*"] },
      { "label": "discord-connector",  "key_env": "SQUAD_DISCORD_TOKEN",
        "scopes": ["channel:discord", "chat.*", "session.*"] }
    ]
  },

  "llm": {
    "primary": { "model": "anthropic/claude-sonnet-4-6" },
    "fallbacks": [
      { "model": "openai/gpt-4o" },
      { "model": "google/gemini-2.0-flash" }
    ],
    "providers": {
      "anthropic":          { "api_key_env": "ANTHROPIC_API_KEY" },
      "openai":             { "api_key_env": "OPENAI_API_KEY" },
      "openrouter":         { "api_key_env": "OPENROUTER_API_KEY" },
      "google":             { "api_key_env": "GOOGLE_API_KEY" },
      "groq":               { "api_key_env": "GROQ_API_KEY" },
      "ollama":             { "base_url":   "http://localhost:11434" },
      "lmstudio":           { "base_url":   "http://localhost:1234/v1" },
      "openai-compatible":  { "base_url":   "https://my-custom-endpoint.example.com/v1",
                              "api_key_env": "MY_CUSTOM_KEY" }
    }
  },

  "plugins": [
    "./extensions/my-cool-tool",
    "./extensions/code-reviewer-subagent",
    "@squad-community/slack-channel"
  ],

  "channels": {
    "discord": { "process": "inproc", "bot_token_env": "DISCORD_BOT_TOKEN" }
  },

  "subagents": {
    "max_concurrent_global": 8,
    "max_concurrent_per_parent": 4,
    "max_tree_depth": 3
  },

  "policy": {
    "approvals": {
      "default": "tag-match",
      "require_for_tags": ["write", "exec", "network"],
      "timeout_seconds": 120
    }
  }
}
```

**Models.** `llm.primary` is the model the runner tries first for every new session. `llm.fallbacks` is an ordered list; if the primary fails with a fallback-eligible error (rate limit, 5xx, timeout, network), the runner advances to the next model in the chain and **sticks there for the rest of the session** — no silent drops back to the primary mid-conversation. Auth and invalid-request failures bypass the chain. Each model is a `"provider/model-id"` string or a bare id whose provider is inferred from the prefix. Per-session overrides flow through `session.start({ model, fallbacks })`.

**Providers.** Each provider entry is a key lookup — `api_key_env` names the env var, `api_key` hard-codes the key, `base_url` overrides the endpoint. Omitted providers fall back to `<PROVIDER>_API_KEY` environment variables by convention. Local providers (`ollama`, `lmstudio`, `llamacpp`, `vllm`) don't require a key.

---

## Deployment

**One Docker Compose service** is the default, and it's the only path we commit to for v1. The gateway, the dashboard (static assets), and the Discord channel all live in one container:

```yaml
services:
  squad:
    image: squad/squad
    ports: ["8080:8080"]
    volumes: [./data:/app/data, ./config.json:/app/config.json:ro]
    environment: [ANTHROPIC_API_KEY, SQUAD_DASHBOARD_TOKEN, DISCORD_BOT_TOKEN]
```

That's the whole stack. The dashboard is served by the gateway at `/`; Discord runs in-process via the `channel-discord` plugin.

**Opt-in split**: for operators who want Discord in its own container (so a bot crash doesn't restart the gateway, or because they run several channels), `examples/compose.split-channels.yml` flips Discord to standalone mode. The channel is the same package, the same code, and the same protocol — the only difference is the process boundary and a `SQUAD_GATEWAY_URL`.

Bare-metal is fine too (`pnpm start`), but we don't ship installers or systemd units in v1.

---

## What v1 is NOT

Deliberately cut so the first release can actually ship:

- **Not multi-user.** One person, one deployment, one dashboard. Multi-tenancy is post-v1.
- **Not Kubernetes.** Helm charts can come later if anyone asks.
- **Subagents yes, ensemble orchestration no.** The subagent primitive gives you delegation, fan-out, and per-worker models. What's not in v1: ensemble voting, automatic role assignment, cross-subagent consensus protocols — those are left to plugin authors.
- **Only one shipped channel (Discord).** The channel contract is designed for any communication medium, but the only first-party channel in v1 is Discord. Slack, Telegram, SMS, email, voice, etc. are planned as channel plugins after v1 ships.
- **Not a marketplace.** You install plugins by pointing at a path or an npm package. No registry, no ratings, no sandbox.
- **Not sandboxed execution.** Tools run in the gateway process. Dangerous tools are approval-gated, not sandboxed. (If you need a sandbox, a plugin can shell out to Docker.)
- **Not a hosted service.** No cloud, no SaaS, no telemetry.
- **No learning loop in v1.** No agent-curated memory, no autonomous skill authoring, no dialectic user modeling. That's hermes's lane and we won't chase it before the core is stable. A MEMORY.md-style injection pattern is pencilled in for v1.1.

---

## Discord Implementation Plan

Discord is the first channel we ship. This section is the concrete build plan for `packages/channel-discord`, separate from the channel abstraction in general so that "how Discord works" doesn't pollute the architecture doc.

**Process model.** The package ships as a channel plugin that loads in-process by default — so the v1 `docker compose up` story is one container. The same package exports a standalone entrypoint (via `@squad/channel-sdk`) for users who want to run it as a separate service. Both modes use the same code paths; only the process boundary changes.

### Goals

1. Prove the channel contract end-to-end: a message in Discord → gateway session → agent run → streamed reply back to Discord.
2. Handle the real-world messiness: long replies, attachments, reactions for approvals, DMs vs. channels, threads, typing indicators.
3. Stay in one file per concern so future channels have a clear template to copy.
4. Demonstrate both deployment modes (in-process, standalone) from the same package with a flag.

### Package layout

```
packages/channel-discord/
├── package.json
├── src/
│   ├── index.ts              # entrypoint: parse env/config, instantiate, run
│   ├── bot.ts                # discord.js Client setup, intents, event wiring
│   ├── inbound.ts            # Discord message → protocol chat.send
│   ├── outbound.ts           # protocol events → Discord messages / edits
│   ├── ask.ts                # questions.asked → buttons / select + modal for "Other"
│   ├── tasks.ts              # tasks.* → pinned embed of the task list, reactions to claim/complete
│   ├── approvals.ts          # reaction-based approve/deny flow
│   ├── session-map.ts        # (guild, channel, user) ↔ session_id
│   ├── formatting.ts         # markdown, code blocks, 2000-char chunking
│   ├── attachments.ts        # upload/download via Discord CDN + gateway blob API
│   ├── capabilities.ts       # declares what the Discord channel can render
│   └── config.ts             # Zod-validated channel config
└── test/
```

### Configuration

```yaml
# in config.json, or a channel-specific file
channel:
  discord:
    bot_token_env: DISCORD_BOT_TOKEN
    gateway_url: ws://gateway:8080
    gateway_token_env: SQUAD_DISCORD_TOKEN
    # Where the bot listens. If empty, responds anywhere it's @mentioned.
    bindings:
      - guild_id: "..."
        channel_id: "..."
        agent: default       # which agent/session config to use
      - dm: true             # also respond in DMs
    # Which tool tags trigger a reaction-based approval prompt.
    approval_tags: ["write", "exec", "network"]
    # Format preferences
    max_message_length: 1900  # safe margin under Discord's 2000
    stream_edits: true        # edit the same message as tokens stream in
```

### Behaviors

**Inbound.**
- `discord.js` `Client` with `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages` intents.
- On `messageCreate`: filter by binding (mention, DM, or configured channel). Resolve `(guild_id, channel_id, user_id) → session_id` via `session-map.ts`, creating via `session.start` if new. Forward content + attachment URLs with `chat.send`.
- Typing indicator starts on receipt, stops on `chat.assistant_message`.

**Outbound.**
- Subscribe to `chat.text_delta`, `chat.assistant_message`, `chat.tool_call`, `chat.tool_result` scoped to this channel's sessions.
- If `stream_edits` is on: first delta creates a new Discord message; subsequent deltas edit it until the final `chat.assistant_message` arrives. Re-chunk at the 1900-char boundary by creating a new message.
- Tool activity renders as a compact italic line (`🔧 running read_file(...)`) — configurable.

**Ask-user questions.**
- On `questions.asked`: post one message per question with 2–4 buttons labelled by option, plus a 5th "Other…" button that opens a modal for free-text. `multiSelect: true` uses a select menu. If any option has a `preview`, the bot posts the previews as a preceding message (ASCII / code block) before the buttons.
- First valid button click from an authorized user wins; call `questions.answer` with the choice + optional note. The original message is edited to show the chosen option and disable the controls.
- Timeout mirrors the gateway policy; the bot posts the timeout reason if it fires.

**Tasks.**
- On `tasks.*`: maintain one pinned embed per active session-tree task list. Render `pending` / `in_progress` (with `activeForm` as the active line) / `completed`. Edit the embed in place as updates arrive — do not spam new messages.
- Optional reactions: ✋ to claim (owner = invoking user), ✅ to mark completed, ❌ to soft-delete. Plugin-gated; off by default so the list isn't a free-for-all.

**Approvals.**
- On `approvals.pending` event where the tool's tags intersect `approval_tags`: post an embed describing the tool call + inputs, with ✅ / ❌ reactions.
- Only the binding's owner (or a configured allowlist) can react. First valid reaction wins; call `approvals.decide` with the verdict.
- Timeout mirrors the gateway policy; the bot posts the denial reason if it fires.

**Attachments.**
- Inbound: Discord attachments are downloaded and re-uploaded to a gateway blob endpoint (or passed by URL if they're public and the agent supports fetch). Agent sees them as content blocks.
- Outbound: assistant messages containing `image` content blocks are uploaded as Discord attachments (`AttachmentBuilder` from buffer).

**Resilience.**
- Reconnect to the gateway with exponential backoff (`@squad/channel-sdk` handles this).
- `discord.js` handles Discord gateway reconnects.
- The `session-map` file is the source of truth across restarts — don't lose conversations just because the bot bounced.

### Phasing

The Discord channel ships in three increments so we can cut a release at each:

| Phase | Scope                                                                               | Release gate                          |
|-------|-------------------------------------------------------------------------------------|---------------------------------------|
| D0    | Inbound text → agent → outbound text. No streaming, no attachments.                 | Chat roundtrip works in one channel.  |
| D1    | Streaming edits, typing indicators, 2000-char chunking, DMs, threads.               | Usable for real conversations.        |
| D2    | **Ask-user buttons + modal**, **task-list pinned embed**, approvals, attachments.   | Feature-complete for v1.              |

### Definition of done for v1

- [ ] D0 / D1 / D2 all merged.
- [ ] End-to-end integration test (real bot token, test guild) runs in CI on main.
- [ ] Docker image published (`squad/channel-discord`).
- [ ] Docs: "Set up a Discord bot in 10 minutes" walkthrough.
- [ ] Failure modes audited: gateway down, Discord down, token revoked, rate-limited. Each has a defined behavior.

---

## Roadmap

**v1 — the stable core**

- [ ] `@squad/protocol` — wire types + Zod (includes `subagents.*`, `tasks.*`, `questions.*`)
- [ ] `@squad/gateway` — WS server, dispatch, sessions, SQLite, plugin host, subagent pool, task store, question store
- [ ] `@squad/runner` — vendor agent-loop.ts + deps
- [ ] `@squad/llm` — vendor types, client factory, and all three provider implementations (anthropic, openai, openai-compatible) covering the full agentic provider list
- [ ] `@squad/tools` — base tool + registry + minimal built-ins + `spawn_subagent` + task tools (`create_task`, `update_task`, `list_tasks`, `get_task`) + `ask_user`
- [ ] `@squad/plugin-sdk` — definePlugin contract (including `subagent` kind)
- [ ] `@squad/channel-sdk` — shared runtime for channel processes + in-process adapter + renderer contract for tasks + questions
- [ ] `@squad/channel-discord` — first-party Discord channel, in-process by default (D0 → D1 → D2, see plan above)
- [ ] `@squad/client-cli` — reference terminal client, 300-ish lines, proves the symmetry claim; renders tasks + asks
- [ ] `@squad/dashboard` — chat (with inline question cards), tasks panel, sessions (subagent tree view), approvals, plugins, channels, routines
- [ ] Approval policy engine (tag-match default, plugin-supplied policies supported)
- [ ] Routines (cron)
- [ ] Docker Compose (one service) + split-channels example
- [ ] `VENDOR.md` with source commit SHAs for every file copied from `lobs/agentic`
- [ ] One example plugin of each kind (including a `code-reviewer` subagent that uses the shared task list)

**v1.1 — ergonomics**

- [ ] FTS5 session search UI (parents and subagents)
- [ ] Memory / skills system (MEMORY.md pattern, injected into user message)
- [ ] Hot-reload for plugins
- [ ] Better error envelopes and plugin-error isolation
- [ ] Path-scoped and host-scoped approval policies from first-party plugins
- [ ] Subagent result caching (hash of input → prior result, opt-in per definition)

**Post-v1 — "if people actually use it"**

- [ ] Second channel (Slack, Telegram, SMS, email — whichever has real demand)
- [ ] Voice channel (realtime audio in + TTS out)
- [ ] IDE channel (ACP bridge or VS Code extension)
- [ ] New providers that don't fit the native-Anthropic / native-OpenAI / OpenAI-compatible trio, as first-party plugins
- [ ] Multi-user / teams
- [ ] Kubernetes Helm chart
- [ ] Plugin marketplace (requires a sandbox story first)
- [ ] Subagent orchestration patterns: ensemble voting, planner/worker templates, consensus protocols

