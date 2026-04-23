# Squad — Implementation Plan

Concrete build plan for Squad v1. Each phase ends at a demoable state
and gets its own commit (or small stack of commits). See `SPEC.md` for
the design and `AGENTS.md` for architectural rules.

## Snapshot

All ten phases of the original v1 plan are shipped on `main`. One
post-plan feature — configurable chat delivery (interrupt vs queue) —
is also in. `pnpm -r build` and `pnpm -r test` are green (49 tests
across 9 packages).

---

## Shipped

### Phase 0 — Workspace scaffold ✓
pnpm workspace, `tsconfig.base.json`, ESLint 9 flat config, Prettier,
Dockerfile, ten package skeletons.

### Phase 1 — `@squad/protocol` ✓
Frame types + every namespace (session, chat, subagents, tasks,
questions, approvals, plugins, channels, routines, admin). Central
`methodRegistry` + `eventRegistry`. `parseFrame` /
`parseFrameString` with typed error envelopes.

### Phase 2 — Vendor from `lobs/agentic` ✓
`runner/{agent-loop,types,hooks,context-engine,context-manager,loop-detector,tool-registry,session,session-transcript}`,
`llm/{types,client,utils,providers/*}`, `tools/{types,base-tool,registry}`.
Pinned at `7daf6df` in `VENDOR.md`. One local edit in `agent-loop.ts`
swaps `createResilientClient` for `createClient`.

### Phase 3 — Gateway skeleton ✓
HTTP + WS server, dispatch table, bearer-token auth, SQLite (WAL +
FTS5), `chat.send` → `runAgent()` → streamed events. Integration test
uses a scripted LLM client against the real WS loop.

### Phase 4 — Tasks primitive ✓
`tasks` table (migration 002), `KeyedMutex<taskListId>`,
`create_task` / `update_task` / `list_tasks` / `get_task` tools with
status-discipline prompts, `tasks.*` dispatch + events, concurrent-
claim race test.

### Phase 5 — Ask-user primitive ✓
`questions` table (003), store with answered/cancelled/timed_out
resolution, `ask_user` tool, full `questions.*` protocol, integration
tests for both answer and timeout paths.

### Phase 6 — `@squad/client-cli` ✓
`ProtocolClient` typed against `methodRegistry`, interactive CLI that
renders streaming chat, live task list, and select-style ask prompts.
Doubles as the reference "any client on top of the protocol".

### Phase 7 — Channel SDK + Discord ✓ (D0 + D1; D2 scaffolded)
- `@squad/channel-sdk`: reconnecting WS client with backoff,
  persistent SessionMap, renderer contract.
- `@squad/channel-discord`: discord.js bot with guild/channel/DM
  routing, stream-edit replies, 2000-char chunking. Standalone entry
  + `examples/compose.split-channels.yml`.
- **Not yet end-to-end:** D2 (ask-user buttons, pinned task embed,
  reaction approvals, attachments) — code paths scaffolded, needs a
  live test guild to verify.

### Phase 8 — Subagents ✓
`subagent_defs` table (004), `SubagentPool` with bounded concurrency
(8 global / 4 per parent, depth 3) and per-tool filtering,
`spawn_subagent` tool, `subagents.*` dispatch + events, cancellation
propagation. `examples/subagents/code-reviewer/` reference.

### Phase 9 — Dashboard ✓
React + Vite served by the gateway at `/`. `BrowserProtocolClient`
mirrors the CLI's client. Views: Chat (with inline ask-user cards and
active-task sidebar), Tasks, Sessions.

### Phase 10 — Plugin host, approvals, routines ✓
- `@squad/plugin-sdk`: `definePlugin()` + `GatewayAPI`, six kinds.
- `PluginHost` dynamically imports `config.plugins`, scoped API,
  cleanup on reload/disable.
- Approval policy engine: `tagMatchPolicy` + `cascade`, allow/deny
  for testing.
- `RoutineScheduler`: 60-second tick, 5-field cron matcher, no
  external cron dep.
- `extensions/example-subagent-plugin/` as the reference plugin.

### Post-plan — Configurable chat delivery ✓
Per-session `deliveryMode` column (migration 005). Config accepts
three shorthand forms (`chat.delivery: "interrupt"`,
`chat.delivery_mode: "interrupt"`, or the full object with
`max_queued` / `collapse_duplicates`), all normalizing to one
internal shape. Default is `interrupt`.

`RunCoordinator` + `DeliveryQueue` own the per-session state. When
`chat.send` hits an active run:
- **interrupt**: queued and injected into the live agent via a
  `before_llm_call` hook (drains `session._ref()` once per turn-gap).
  Leftovers after the run fire a follow-up turn so nothing is stranded.
- **queue**: held until `after_agent_end`, then one message is drained
  and fires a fresh turn via the same chat path.

`chat.send` result now includes `status: "running" | "queued"` and
optional `queuePosition`. Covered by config-parsing unit tests and
end-to-end integration tests that gate the scripted LLM to force the
race.

---

## Remaining before v1 is truly feature-complete

### Discord D2
Ask-user buttons + modal, pinned task embed that edits in place,
reaction-based approvals, attachment upload/download. All protocol +
SDK scaffolding is in; needs the actual discord.js integration plus a
live bot token + test guild for the integration test.

### Approval escalation wiring
The policy engine cascade exists. What's missing: a `before_tool_call`
hook in the gateway that runs the cascade, inserts an `approvals` row
on "escalate", broadcasts `approvals.pending`, awaits the decision
via `approvals.decide`, and returns an error `ToolResult` on deny.

### Routine execution
`RoutineScheduler` fires on schedule, but the runner currently just
creates a session. It needs to push `r.prompt` through the chat path
(same `runChatTurn` used by `chat.send`) and, on completion, dispatch
the output to `r.delivery` (silent / dashboard / Discord channel).

### FTS5 session search
The index is populated from day one. `session.search` is a stub —
wire it to `messages_fts` with snippet extraction, then add a
dashboard panel.

### Subagent tree in dashboard
`subagents.tree` returns the tree; the dashboard currently only lists
top-level sessions. A hierarchical Sessions view + per-subagent
transcript surface would round out the demo.

---

## Cross-cutting

- **Testing:** integration tests use the real WS loop + real SQLite
  (temp file); tool tests use the real registry. No protocol-layer
  mocks.
- **Vendor hygiene:** every vendored-file edit updates the header +
  `VENDOR.md` in the same commit.
- **Logging:** `pino` everywhere; no `console.log` in library code.
- **Commit cadence:** one commit per logical sub-part. No PRs — land
  on `main`.
