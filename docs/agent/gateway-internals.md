# Gateway internals

What actually happens between "user sends a message" and "agent finishes a
turn." The gateway is a single process; everything below is in one Node
runtime.

## The hot path

`packages/gateway/src/runs.ts` (function: `runChatTurn`).

Per turn:

1. Persist the user's message to `messages` (unless the caller already did,
   e.g. queue mode).
2. Load full history from SQLite, fold persisted `tool` rows back into
   `user`-shaped messages with `tool_result` blocks (the runner expects that).
3. If `/compact` was armed, call `compactMessages(history)` and clear the flag.
4. Mark the session `running`. Construct an in-memory `Session(history)`.
5. Wire up the **incremental persister** (`run-persistence.ts`) — flushes
   after every LLM call so a crash mid-run doesn't strand the dashboard.
6. Pull memory blocks: eager (frozen at session start, kept in the cacheable
   prefix) + per-turn FTS retrieval against the latest user input.
7. Compute the per-turn tool allow-list:
   - If `toolsAllow` was passed (e.g. cron jobs) → that wins.
   - Else if `toolGroups` was passed → defaults + per-session unlocked groups
     + `describe_tool_group`.
   - Else → every registered tool.
8. Walk up from `cwd` collecting `AGENTS.md` / `CLAUDE.md` / `SQUAD.md` /
   `.cursorrules` files (cap ~8K tokens, drop farthest first).
9. Build the system prompt via `agent-prompt.ts/buildSquadSystemPrompt`.
10. Compute the per-turn `RenderContext` (`renderContextFor(sessionId)`):
    look up the session's binding in `ChannelRegistry`; falls back to
    `subagent` if there's a parent, else `dashboard`. Wrap the runner call
    in `promptContextStore.runWithRender(render, () => runAgent(spec))`
    so every `BaseTool.describe(ctx, render)` and fragment `when`
    predicate sees the right surface for this turn.
11. Call `runAgent(spec)` from the vendored runner.
    - `onTextChunk` broadcasts `chat.text_delta`.
    - `onProgress` writes `tool_calls` rows and broadcasts `chat.tool_call` /
      `chat.tool_result`.
12. Persist the final assistant message; broadcast `chat.assistant_message`;
    set the session `idle`.

## PromptContextStore (live extension surface)

`packages/tools/src/prompt-context.ts` — owned by the gateway, shared with
the tool registry. Holds the current `PromptContextSnapshot`:

```
channels       ← refreshed by ChannelRegistry.onChannelChanged
deliveryKinds  ← refreshed by DeliveryRegistry.onChange
plugins        ← refreshed by PluginHost.onPluginChanged
skills,        ← seeded after plugin boot, refreshed on plugin events
toolsets
fragments      ← addFragments(...) when a plugin calls
                  api.promptFragments.register(...);
                  removeFragmentsForPlugin(id) on unload
startupWarnings
version        ← bumped on every mutation
```

Tools extending `BaseTool` opt into dynamic descriptions by implementing
`describe(ctx, render)`. `BaseTool.toEntry()` returns a `ToolEntry` whose
`definition` is a getter — every read re-runs `describe` against the
current snapshot + AsyncLocalStorage `RenderContext`. Plugin
load/unload, channel connect/disconnect, and delivery register/unregister
all bump `version`, so the next turn picks up the change. **No restart.**

See [plugins.md](plugins.md) § "Conditional prompt fragments" for the
authoring side and the slot taxonomy.

## System prompt

`packages/gateway/src/agent-prompt.ts` is the source of truth. It assembles
the prompt from several layers. Order matters because Anthropic prompt
caching keys on the prefix:

1. **Squad onboarding** — what Squad is, how messages reach the agent
   (`interrupt` vs `queue` mode).
2. **Tool groups index** — the lazy-group `<tool_groups>` block.
3. **Workspace + core files contract** — your persistent home, how to grow
   memory.
4. **Live `SOUL.md` / `USER.md` / `MEMORY.md`** from `.squad/` (re-read every
   turn, so edits take effect on the next turn).
5. **Project context** — discovered `AGENTS.md` / `CLAUDE.md` / `SQUAD.md`
   from walking up from `cwd`.
6. **Startup warnings** — entries from `PromptContextStore.startupWarnings`
   (degraded plugin state, missing perms, OAuth expired). Pulled fresh
   each turn via `deps.promptContextStore?.get().startupWarnings`. Empty
   list → section skipped.
7. **Persistent memory** — eager block (frozen) + per-turn retrieval block.

Subagents build the same prompt with their own `.squad/subagents/<name>/`
core dir (see `subagentCoreDir`).

## Delivery modes

`packages/gateway/src/delivery/coordinator.ts`:

- **interrupt** (default): if a message arrives while a run is in flight, it
  gets injected into history at the next `before_llm_call` boundary. The
  agent sees it mid-task.
- **queue**: messages wait for the current turn to finish, then trigger a
  fresh turn in arrival order.

Mode is per-session, set via session config; the agent doesn't choose. The
hook fires on every run; it's scoped to sessions the coordinator knows are
active. **Subagent runs bypass the coordinator** — the subagent pool
serialises them.

## Subagent execution

`packages/gateway/src/subagents/`:

- `pool.ts` — `SubagentPool` enforces concurrency (per-parent + global),
  depth, token / tool-call / time budgets. Builds the same Squad system
  prompt for the child, narrows tools per the definition, broadcasts on
  `subagents.*` topics.
- `registry.ts` — registered subagent definitions (name → spec).
- `runtime.ts` / `runtime-stdio.ts` — non-Squad runtimes (e.g. Claude Code
  bound via stdio) plug in here.
- `backend.ts` — the dispatch handlers' backend (list, spawn, cancel, tree).

## Crash recovery

`packages/gateway/src/restart/recovery.ts` runs at boot. It scans for
sessions left in `status='running'` from the previous process, repairs
truncated transcripts (fabricates synthetic `tool_result` blocks for
unmatched `tool_use` blocks so Anthropic doesn't reject the history), marks
orphan `pending` `tool_calls` rows as `failed`, broadcasts `session.resumed`,
and re-fires a fresh turn so the agent picks up where it left off.

The crash window is one in-flight LLM turn — `runs.ts` flushes at every
`before_llm_call` boundary.

## Approval engine

`packages/gateway/src/approvals/`:

- `policy.ts` — built-in policies (`tagMatchPolicy`, `cascade`).
- `rules.ts` / `rules-persist.ts` — user-defined allow lists.
- `hook.ts` — installs the runner `before_tool_call` hook that consults the
  policy chain. On `escalate` it inserts a row in `approvals`, broadcasts
  `approvals.pending`, and awaits a decision (with timeout).
- Plugins can register additional `ApprovalPolicy` implementations; the
  cascade returns the first non-`escalate` decision.

## Cron / routines

`packages/gateway/src/routines/`:

- `scheduler.ts` — 60-second tick, finds due routines.
- `executor.ts` — runs the routine in a fresh / isolated / reused session,
  honouring `payload` (`prompt`, `script`, `scriptThenPrompt`) and `execution`
  (model, tool allow-list, timeout).
- `delivery.ts` + `DeliveryRegistry` — fans the result out to silent /
  dashboard / channel-registered handlers.
- `persistence.ts` — `data/cron/runs/` log dirs, with orphan pruning at boot.

## Memory (MemCore)

`packages/gateway/src/memory/`:

- Backed by a separate `memcore` package (Postgres or local). `service.ts`
  exposes `eagerForSession(sessionId)` and `retrievalForTurn(query, scope)`.
- `session-ingest.ts` — extraction pipeline that turns finished runs into
  memory entries.
- The `memory` tool group lets the agent propose / update / archive / search
  entries from inside a turn.
- See [storage-and-memory.md](storage-and-memory.md) for shape.

## Other gateway-side stores you'll see referenced

| Path                                          | Owns                                      |
|-----------------------------------------------|-------------------------------------------|
| `db/sessions.ts`                              | `sessions` rows; per-session unlocked tool groups |
| `db/messages.ts`                              | `messages` rows; FTS5 index               |
| `db/tool-calls.ts`                            | `tool_calls` rows                          |
| `db/subagent-defs.ts`                         | cached subagent definitions for the tree view |
| `tasks/store.ts` + `tasks/mutex.ts`           | `tasks` rows under per-list lock          |
| `questions/store.ts`                          | `questions` rows; pending-ask coordination |
| `approvals/store.ts`                          | `approvals` rows                          |
| `routines/store.ts`                           | `routines` rows                           |
| `channels/registry.ts`                        | live channel adapters                     |
| `toolsets/registry.ts`                        | toolset bundles                           |
| `commands/registry.ts`                        | plugin-contributed slash commands         |
| `mcp/registry.ts`                             | MCP server registry                       |
| `peers/source.ts`                             | peer discovery                            |
| `auth.ts` + `auth/pairing.ts`                 | tokens, pairing, scope authorisation      |
| `broadcast.ts`                                | scoped subscription bus                   |
| `traces.ts`                                   | trace.step events                         |
| `doctor/`                                     | health check engine                       |

## Source map for the hot path

- `packages/gateway/src/runs.ts` — `runChatTurn` end-to-end.
- `packages/gateway/src/agent-prompt.ts` — system prompt assembly + core files.
- `packages/gateway/src/run-persistence.ts` — incremental flush + final write.
- `packages/gateway/src/delivery/coordinator.ts` — interrupt / queue.
- `packages/gateway/src/restart/recovery.ts` — crash recovery.
- `packages/gateway/src/index.ts` — boot, plugin host, dispatcher wiring.
