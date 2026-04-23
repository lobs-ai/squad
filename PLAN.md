# Squad — Implementation Plan

Concrete, phased build plan for Squad v1. Each phase ends at a demoable state and gets its own commit (or small stack of commits). See `SPEC.md` for the design and `AGENTS.md` for architectural rules.

---

## Phase 0 — Workspace scaffold

- `pnpm-workspace.yaml`; root `package.json` with `dev` / `build` / `test` / `lint` / `format`.
- `tsconfig.base.json` (strict ESM, NodeNext, composite refs).
- `.eslintrc`, `.prettierrc`, `.nvmrc` (Node 20+).
- Empty package skeletons at the paths `AGENTS.md` fixes:
  `protocol`, `runner`, `llm`, `tools`, `plugin-sdk`, `channel-sdk`, `channel-discord`, `client-cli`, `dashboard`, `gateway`.
- `Dockerfile` (multi-stage: pnpm build → slim runtime with `better-sqlite3`).
- Wire `docker compose up` to fail fast on missing `ANTHROPIC_API_KEY`.
- Update `CONTRIBUTING.md` to describe the real package layout (currently describes the old `runtime/` + `connectors/`).

**Done when:** `pnpm install && pnpm -r build` succeeds on an empty workspace.

## Phase 1 — `@squad/protocol`

Every downstream package imports these, so do this first.

- Frame types: `request`, `response`, `event`, `subscribe` / `unsubscribe`. One Zod schema per method + event.
- Namespaces, schemas only (no handlers yet): `session.*`, `chat.*`, `subagents.*`, `tasks.*`, `questions.*`, `approvals.*`, `plugins.*`, `channels.*`, `routines.*`, `admin.*`.
- Error envelope type.
- `parseFrame(unknown) → Frame | ProtocolError` for both gateway and client use.

**Done when:** every method/event in `SPEC.md` §Wire Protocol has a schema and a TS type, validated both directions in unit tests.

## Phase 2 — Vendor from `lobs/agentic`

`VENDOR.md` lists the exact files. One commit per package; each adds header comments + commit SHA in the same commit.

- `@squad/runner`: `agent-loop.ts`, `types.ts`, `hooks.ts`, `context-engine.ts`, `loop-detector.ts`. Skip `session.ts`.
- `@squad/llm`: `types.ts`, `client.ts`, `providers/{anthropic,openai,openai-compatible}.ts`. Validate `KNOWN_PROVIDERS` covers every entry in `SPEC.md` §`@squad/llm`.
- `@squad/tools`: `base-tool.ts`, `registry.ts`. No built-ins yet — those come in phases 3 / 4 / 7.

**Risk:** agentic's `session.ts` is intertwined with its runtime layer. Expect the runner files to reference session types we are not taking — the vendoring step will need small cuts / shims.

**Done when:** a trivial `runAgent({messages, tools: [], model})` works against a real Anthropic key (gated on env).

## Phase 3 — Gateway skeleton

- HTTP server (health, static asset handler placeholder).
- WebSocket server with dispatch table keyed on `method`.
- Auth: single shared token (config-declared), scope check stub.
- SQLite bootstrap via `better-sqlite3`: migrations for `sessions`, `messages`, `tool_calls` (other tables land with their features). FTS5 index on `messages`.
- One working method: `chat.send` → create/reuse session → `runAgent()` → stream `chat.text_delta` / `chat.assistant_message` → persist → return.
- Hook wiring: `after_tool_call` persists; `before_tool_call` is a pass-through for now.
- Integration test using a raw `ws` client (no mocks) that does `session.start` → `chat.send` → asserts streamed deltas arrive in order.

**Done when:** `pnpm dev` + a `ws` script can hold a conversation through the gateway.

## Phase 4 — Tasks primitive

Tasks before subagents and before Discord — cheap, high-value, and subagents need them.

- Migrations: `tasks` table + `task_list_id` resolution to session-tree root.
- `packages/gateway/src/tasks/` store with a per-list `AsyncMutex`; every mutation is read-compute-write inside the lock.
- Tools in `packages/tools/src/tasks/`: `create_task`, `update_task`, `list_tasks`, `get_task`. Each has a `*prompt.ts` sibling with the guidance from `SPEC.md` §Tasks.
- Protocol handlers: `tasks.create` / `update` / `get` / `list` / `delete` / `claim` / `watch`; events `tasks.created` / `updated` / `deleted`.
- Tests: concurrent-claim race test (two "subagents" racing, one wins cleanly).

**Done when:** CLI / ws script can call the task tools through an agent run and watch the task list update live over a subscription.

## Phase 5 — Ask-user primitive

- Migration: `questions` table.
- `packages/gateway/src/questions/` store keyed by correlation id.
- `ask_user` tool in `packages/tools/src/`.
- Protocol: `questions.ask` / `answer` / `cancel` / `list` / `history`; events `questions.asked` / `answered` / `cancelled` / `timed_out`.
- `channels.capabilities` schema + gateway rejection logic for over-option'd asks (never silently drop).

**Done when:** an agent can call `ask_user` and any subscribed client can resolve it.

## Phase 6 — `@squad/client-cli`

- Minimal terminal client: auth → subscribe → send `chat.send` → render streaming text.
- Renders tasks (checklist with spinner) and `ask_user` (interactive select + "Other…" editor prompt).
- This is the reference client and our integration-test harness.

**Release gate:** end-to-end without Discord.

## Phase 7 — Channel SDK + Discord (D0 → D1 → D2)

- `@squad/channel-sdk`: WS client with reconnect, session map (file-persisted), renderer contract (`renderTaskList`, `handleTaskAction`, `renderAsk`, etc.), in-process adapter.
- `@squad/channel-discord` follows the phasing in `SPEC.md` §Discord Implementation Plan:
  - **D0**: inbound text → agent → outbound text. Single channel, no streaming.
  - **D1**: streaming edits, typing indicators, 2000-char chunking, DMs.
  - **D2**: ask-user buttons + modal, pinned task embed, reaction approvals, attachments.
- Gateway loads Discord as an in-process plugin by default; `examples/compose.split-channels.yml` flips it to standalone.
- Integration test gated on `DISCORD_BOT_TOKEN` and `DISCORD_TEST_GUILD`.

## Phase 8 — Subagents

- Migrations: `sessions.parent_session_id`, `sessions.subagent_def_id`, `subagent_defs`.
- `packages/gateway/src/subagents/pool.ts`: bounded concurrency (8 global / 4 per parent), depth cap (3), per-definition token / tool-call limits enforced before run.
- `spawn_subagent` built-in tool; subagents inherit the tree's task list automatically.
- `subagents.*` protocol: events on their own topic; `subagents.tree` query.
- Cancellation propagation (parent cancel → descendants).
- First example plugin: `examples/subagents/code-reviewer/` using `read_file` only.
- CLI + Discord renderers for subagent trees.

## Phase 9 — Dashboard

React + Vite served statically by the gateway at `/`.

- Views in order of value: Chat (with inline `ask_user` cards) → Tasks → Sessions (tree view with FTS5 search) → Approvals → Plugins → Channels → Routines → Logs → Settings.
- No dashboard-only gateway endpoints — if something needs one, fill the protocol gap.

## Phase 10 — Plugin host hardening, approvals, routines

- Plugin host: `extensions/` discovery + npm-package plugins, `register(api)` with scoped `GatewayAPI`, cleanup on unload / reload.
- Approval policy engine: `tag-match` default, plugin-supplied policies, cascade.
- Routines: 60-second tick, `routines` table, `[SILENT]` / Discord / dashboard delivery.
- One example plugin per kind (tool, provider, channel, skill, routine, subagent).

---

## Cross-cutting

- **Testing:** integration tests use the real WS loop + real SQLite (temp file); tool tests use the real registry. No protocol-layer mocks.
- **Vendor hygiene:** every vendored-file edit updates the header + `VENDOR.md` in the same commit.
- **Logging:** `pino` everywhere; no `console.log` in library code.
- **Sequencing:** do not start Discord before the CLI works end-to-end.

## Commit cadence

One commit per phase, or per logical sub-part of a phase (e.g., one commit per vendored package in phase 2). No PRs in v1 — land on `main`.
