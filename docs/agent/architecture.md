# Architecture

## What Squad is

A self-hostable agent platform. One **gateway** process owns:

- WebSocket + HTTP server
- Session storage (SQLite)
- The agent loop (vendored from `lobs/agentic` — see [vendoring.md](vendoring.md))
- The plugin host
- The subagent pool
- The task store, the question store, the approval queue
- The cron-based **routine** scheduler
- The dashboard (served as static assets at `/`)

Every other piece — Discord, the React dashboard, the CLI, third-party UIs —
is a **client** that opens a WebSocket to the gateway and speaks the same
protocol. The dashboard has no privileged access; if it can do something, the
protocol exposes it and any client can do the same.

```
┌──────────────────┐     ┌──────────────────────────────────────┐
│ channel-discord  │─WS─▶│                                      │
│ dashboard        │─WS─▶│              Gateway                 │
│ client-cli       │─WS─▶│                                      │
│ <your client>    │─WS─▶│   dispatch · plugin host · runs.ts   │
└──────────────────┘     │                                      │
                         │   subagent pool · tasks · questions  │
                         │   approvals · routines · MemCore     │
                         │                                      │
                         │   SQLite (sessions / messages /      │
                         │   tool_calls / tasks / questions / …)│
                         └──────────────────────────────────────┘
```

## The four primitives

Subagents, tasks, ask-user questions, and the protocol itself. See
[primitives.md](primitives.md) for the agent-facing contract; see `SPEC.md`
for the design rationale.

## Architectural rules (from `AGENTS.md`)

These are load-bearing. Don't break them.

1. **Gateway is the center.** Channels never talk to each other or to runtimes
   directly — only to the gateway.
2. **No client is privileged.** The dashboard does nothing the protocol
   doesn't expose.
3. **Gateway is channel-agnostic.** No `discord.js` (or `slack`, `telegram`,
   `nodemailer`, …) imports in `packages/gateway`. Channel knowledge lives in
   `packages/channel-<name>` and loads as a plugin — even when in-process.
4. **Protocol is the contract.** Every wire message has a Zod schema in
   `packages/protocol/src/namespaces/`. If it isn't there, it doesn't exist.
5. **Runner and LLM are vendored.** Don't add `@agentic/*` as dependencies.
6. **Subagents, tasks, questions are primitives.** Each has its own protocol
   namespace and its own gateway store. Don't bolt new features onto `chat.*`.
7. **Channels render intent, agents emit intent.** Agents call `ask_user`,
   `create_task`, `spawn_subagent` — never write Discord markdown directly.
8. **Plugins are the extension mechanism.** New tools, providers, channels,
   skills, routines, and subagent definitions all go through `definePlugin()`.
9. **One process, one agent loop.** The runner runs in-process inside the
   gateway. No "runtime as separate WS service" pattern.
10. **Self-hosting first.** No telemetry, no phone-home, no hosted backend.

## Packages

```
packages/
├── gateway/         # WS/HTTP, dispatch, runs.ts, plugin host, all gateway-side stores
├── runner/          # Agent loop (VENDORED — agent-loop.ts, hooks.ts, session.ts, …)
├── llm/             # LLMClient + provider implementations (VENDORED)
├── tools/           # BaseTool + registry + built-ins + tool groups (lazy loading)
├── protocol/        # Wire types + Zod schemas — the contract
├── plugin-sdk/      # definePlugin() + GatewayAPI surface for plugin authors
├── channel-sdk/     # Shared runtime for channel processes + renderer contract
├── channel-discord/ # First-party Discord channel (in-process by default)
├── client-cli/      # Reference terminal client
└── dashboard/       # React + Vite UI, served by the gateway at /
extensions/          # User-authored plugins (tools, channels, providers, subagents, …)
examples/            # compose files, sample config, starter subagent definitions
```

Single-purpose, no cross-imports against the rules. Clients depend on
`@squad/protocol`, never the other way around.

## Single-process deployment

Default: one Docker Compose service. The gateway, dashboard statics, and the
Discord channel all live in one container. See `examples/compose.yml`.

Opt-in split: `examples/compose.split-channels.yml` runs Discord as its own
process via `@squad/channel-sdk`. Same code, same protocol — only the process
boundary changes.

## Conditional prompt fragments

Tool descriptions and parts of the system prompt are **rendered live** per
turn against two snapshots:

- **`PromptContextStore`** — what's loaded right now: channels, registered
  delivery handlers, installed plugins, skills, toolsets, plugin-supplied
  fragments, startup warnings. Mutations (plugin load/unload, delivery
  handler register/unregister, channel connect/disconnect) bump a `version`
  and notify subscribers, so the next turn sees fresh descriptions
  without a restart.
- **`RenderContext`** — where the current turn is rendering: surface
  (`dashboard` / `cli` / `channel` / `cron-isolated` / `subagent`),
  channel kind (`discord`, `slack`, …), channel id, capabilities, parent
  subagent. Threaded per-turn via `AsyncLocalStorage` from
  `gateway/runs.ts` (`store.runWithRender(render, () => runAgent(spec))`).

Plugins extend tool descriptions by registering **fragments** at named
**slots** (`PROMPT_SLOTS.*`). Tools like `cron`, `ask_user`, `web_fetch`,
`exec`, `web_search`, `spawn_subagent` look up the fragments for their
slots and inline them. Fragments may carry a `when(render, ctx)`
predicate so e.g. Discord-specific hints only appear on Discord turns.

See [plugins.md](plugins.md) § "Conditional prompt fragments" for the
authoring API and [gateway-internals.md](gateway-internals.md) for how
the store is wired into per-turn execution.

## Where to look next

- **"How does a turn actually run?"** → [gateway-internals.md](gateway-internals.md)
  (`runs.ts`, `agent-prompt.ts`, persistence, recovery)
- **"What can the agent see / call?"** → [tool-groups.md](tool-groups.md) +
  [primitives.md](primitives.md)
- **"How is data laid out?"** → [storage-and-memory.md](storage-and-memory.md)
