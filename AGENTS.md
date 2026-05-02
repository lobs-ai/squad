# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this project is

Squad is a self-hostable agent platform that competes on **usability** and **subagents**. The four load-bearing primitives:

1. **Subagents.** The parent agent can spawn workers with their own model, tools, system prompt, and budget. They run in parallel, get their own sessions, and broadcast on their own topics.
2. **Tasks.** A shared task list scoped to the session tree. Agents (parent and subagents) create, claim, and complete tasks; users see the same list.
3. **Ask-user questions.** Structured multiple-choice questions with channel-native rendering — Discord buttons, dashboard cards, CLI select. One tool call, native UX per client.
4. **The protocol is the product.** Every client — Discord, dashboard, CLI, third-party UI — speaks the same WebSocket wire. Subagents, tasks, and questions are protocol primitives; no client is privileged.

And one discipline: **vendored, not imported.** `packages/runner` and `packages/llm` are copied from `lobs/agentic` with commit SHAs pinned in `VENDOR.md`. Re-sync is deliberate.

One **gateway** process owns sessions, the agent loop, plugins, storage, the subagent pool, the task store, and the question store. Channels and clients connect over the same WebSocket wire protocol as the **React dashboard** (served by the gateway). See `SPEC.md` for the full design.

v1 ships exactly one first-party channel — **Discord** — to prove the contract end-to-end. By default Discord runs **in-process** as a channel plugin so `docker compose up` is one container. The same package runs as a standalone process via `@squad/channel-sdk` when users want isolation. See the [Discord Implementation Plan](SPEC.md#discord-implementation-plan) in `SPEC.md`.

**LLM providers:** v1 ships every provider the vendored `packages/llm` supports (all of agentic's providers — anthropic, openai, openrouter, google, groq, deepseek, mistral, together, xai, perplexity, fireworks, cerebras, cohere, sambanova, novita, hyperbolic, lambda, ollama, lmstudio, llamacpp, vllm, z-ai, minimax, kimi, opencode-zen, opencode-go, plus the `openai-compatible` escape hatch). They all run through three client implementations: native Anthropic, native OpenAI, and a shared OpenAI-compatible client. The default model is Anthropic but any installed provider is usable per-session — and per-subagent.

## Stack

- **Language:** TypeScript strict, ESM
- **Runtime:** Node.js 20+
- **Package manager:** pnpm (workspaces)
- **Transport:** WebSocket (primary) + HTTP (health, static dashboard, a little admin REST)
- **Storage:** SQLite (single file; `better-sqlite3` or `bun:sqlite`)
- **Container:** Docker / Docker Compose
- **Validation:** Zod for every wire boundary
- **Dashboard:** React + Vite

## Package layout

```
squad/
├── packages/
│   ├── gateway/            # WS/HTTP server, dispatch, plugin host, storage, subagent pool,
│   │                       # task store, question store
│   ├── runner/             # Agent loop (VENDORED from ../agentic — see VENDOR.md, do not add as dep)
│   ├── llm/                # LLMClient + provider implementations (VENDORED from ../agentic)
│   ├── tools/              # BaseTool + registry + built-in tools:
│   │                       # spawn_subagent, create_task, update_task, list_tasks, get_task, ask_user
│   ├── protocol/           # Wire types + Zod schemas (includes subagents.*, tasks.*, questions.*)
│   ├── plugin-sdk/         # definePlugin() contract (kinds: tool, provider, channel, skill, routine, subagent)
│   ├── channel-sdk/        # Shared runtime for channel processes + renderer contract for tasks + questions
│   ├── channel-discord/    # First-party Discord channel (in-process by default; standalone supported)
│   ├── client-cli/         # Reference terminal client — proves any client can be built on the protocol
│   └── dashboard/          # React + Vite web UI
├── extensions/             # User-authored plugins
├── examples/
│   ├── compose.yml                  # default: one service, Discord in-process
│   ├── compose.split-channels.yml   # opt-in: gateway + discord as separate services
│   └── subagents/                   # starter subagent definitions
├── VENDOR.md               # pinned source commits for files copied from lobs/agentic
└── docs/
```

Keep packages single-purpose. The gateway must not import `discord.js` (or any channel-specific library) directly; channel-ness lives in the channel packages and is loaded via the plugin host. Clients depend on `@squad/protocol`, never the other way around.

## Architectural rules (don't break these)

1. **Gateway is the center.** Every client (channel, dashboard, CLI, third-party) talks to the gateway, never directly to each other or to runtimes.
2. **No client is privileged.** The dashboard does nothing the protocol doesn't expose. If you find yourself adding a gateway endpoint "for the dashboard only", stop — put it in the protocol or don't add it.
3. **Gateway is channel-agnostic.** No `discord.js` (or `slack`, `telegram`, `nodemailer`, etc.) imports in `packages/gateway`. Channel knowledge lives in `packages/channel-<name>`, loaded as a plugin — even when it runs in-process.
4. **Protocol is the contract.** Every new message type goes in `packages/protocol` with a Zod schema first, then implementations follow. If it's not in the protocol, it doesn't exist.
5. **Runner and LLM are vendored.** `packages/runner` and `packages/llm` are copied from `lobs/agentic` with commit SHAs pinned in `VENDOR.md`. Don't add `@agentic/*` as dependencies. Do evolve the copies freely, but record edits in the file header and re-sync PRs.
6. **Subagents, tasks, and questions are primitives.** Each has its own protocol namespace (`subagents.*`, `tasks.*`, `questions.*`), its own store in the gateway, and its own renderer contract in `@squad/channel-sdk`. Don't bolt new features onto `chat.*` — extend the right namespace or add a new one.
7. **Channels render intent, agents emit intent.** Agents never write Discord markdown or dashboard HTML. They call `ask_user`, `create_task`, etc., and channels turn those into native UX. A new channel is "implement the renderer contract" — no gateway or agent-side changes.
8. **Plugins are the extension mechanism.** New tools, LLM providers, channels, skills, routines, and subagent definitions go through `definePlugin()`. Resist adding special cases in the gateway for specific plugins or specific channels (including Discord).
9. **One process, one agent loop.** v1 runs `runAgent()` in-process in the gateway. No "runtime service" over WS. This was cut from the older design deliberately — don't bring it back without a real reason.
10. **Self-hosting first.** No hosted-service URLs, no telemetry, no phone-home. Config points at user-provided credentials only.

## What to vendor from `../agentic`

Source paths are relative to `/Users/rafe/other/lobs/agentic`. Every copied file gets a header comment with the source path, the source commit SHA, and the date copied, and `VENDOR.md` is updated in the same commit. Do not skip either step.

**Must-have (into `packages/runner/src/`):**
- `packages/runner/src/agent-loop.ts`
- `packages/runner/src/types.ts`
- `packages/runner/src/hooks.ts`
- `packages/runner/src/loop-detector.ts`
- `packages/runner/src/context-engine.ts`

**Must-have (into `packages/llm/src/`):**
- `packages/llm/src/types.ts`
- `packages/llm/src/client.ts` — includes `parseModelString()`, `inferProvider()`, the full `KNOWN_PROVIDERS` list, and the `createClient()` factory that dispatches to the right provider implementation.
- `packages/llm/src/providers/anthropic.ts` — native Anthropic SDK.
- `packages/llm/src/providers/openai.ts` — native OpenAI SDK (also serves `openai-codex`).
- `packages/llm/src/providers/openai-compatible.ts` — shared OpenAI-compatible client that backs every remaining provider (openrouter, google, groq, deepseek, mistral, together, xai, perplexity, fireworks, cerebras, cohere, sambanova, novita, hyperbolic, lambda, ollama, lmstudio, llamacpp, vllm, z-ai, minimax, kimi, opencode-zen, opencode-go, openai-compatible).

**Must-have (into `packages/tools/src/`):**
- `packages/tools/src/base-tool.ts`
- `packages/tools/src/registry.ts`

**Skip:** agentic's `session.ts` (we use our own SQLite session store) and the runtime layer. Take the full provider set — v1 ships all of them.

The full pin list (including SHAs once files are copied) lives in `VENDOR.md`. Any local edit on top of a vendored file must be visible in the file header and in the next re-sync PR.

## Conventions

- TypeScript strict mode. No `any` without a comment justifying it.
- ESM (`"type": "module"`).
- Use `zod` for runtime validation at every protocol boundary — wire messages are untrusted input.
- Async/await only; no callback APIs in new code.
- Errors crossing the wire are serialized via the protocol's error envelope, not raw stack traces.
- Logging via a single shared logger (`pino` likely). Never `console.log` in library code.
- Every plugin gets a scoped `GatewayAPI` handle; plugins should not import from `@squad/gateway` directly.

## Commands

Intended scripts (scaffold these in the relevant `package.json` as you go):

```bash
pnpm install        # install workspace deps
pnpm dev            # run gateway + dashboard in watch mode
pnpm build          # build all packages
pnpm test           # all tests
pnpm lint           # eslint
pnpm format         # prettier
pnpm start          # full local stack via `squad mgr` (gateway + discord)
```

If a script you need doesn't exist, add it to the appropriate `package.json` rather than running raw `tsc`/`node` commands.

## Tests

- Unit tests live next to source as `*.test.ts`.
- Integration tests for gateway ↔ connector / gateway ↔ dashboard flows go in `packages/gateway/test/integration/`.
- Don't mock the protocol layer in integration tests — exercise the real WebSocket loop.
- When testing tools, use the real tool registry, not a stub.

## UI testing

When you change anything the user sees in the dashboard (`packages/dashboard`) — new views, layout changes, protocol-driven rendering of subagents/tasks/questions, auth flow, etc. — verify it in a real browser before reporting the task done. Use the **vibium** skill to drive Chromium: load the running dashboard, exercise the affected flow, and check the actual rendered state (DOM, screenshots, console errors). Type checks and unit tests do not catch broken UI.

- Start the dev stack first (`pnpm dev` or whatever script runs gateway + dashboard) so the dashboard is served.
- Drive the golden path and at least one edge case (empty state, error state, or a mid-flight WS event).
- If you cannot reach the UI for some reason, say so explicitly instead of claiming the change works.

## When adding a tool

1. Extend `BaseTool` in the owning package (usually `packages/tools/src/<tool>.ts`, or a plugin).
2. Give it accurate `tags` — they drive approval policy.
3. If it's a built-in, register it in the default registry factory. If it's a plugin, register it in the plugin's `register()`.

## When adding a plugin kind

1. Add the kind to `packages/plugin-sdk/src/types.ts`.
2. Add a registration API on `GatewayAPI` (e.g. `api.tools.register`).
3. Implement the host side in `packages/gateway/src/plugins/`.
4. Document the kind in `SPEC.md`.

## When adding or changing a subagent primitive

1. Schema lives in `packages/protocol/src/subagents/` — add the method/event first.
2. The pool (bounded concurrency, bounded depth, budget enforcement) lives in `packages/gateway/src/subagents/`. Don't reinvent it elsewhere.
3. A new built-in subagent definition goes in `examples/subagents/` as a first-party plugin, not hard-coded in the gateway.
4. Dashboard tree view and client-cli rendering both need to handle the new event/method, or the change is incomplete.

## When adding or changing a task-list feature

1. Schema lives in `packages/protocol/src/tasks/` — method or event first.
2. Task mutations go through the gateway's per-list lock in `packages/gateway/src/tasks/`. Don't read-modify-write outside that path; concurrent subagents will clobber each other.
3. Changes to the tool prompts (`packages/tools/src/tasks/*prompt.ts`) are the single biggest lever on agent behavior — edit them deliberately and test against a real agent run.
4. Every client that renders tasks (`dashboard`, `channel-discord`, `client-cli`) must be updated in the same PR, or the feature is half-shipped.

## When adding or changing ask-user

1. Schema lives in `packages/protocol/src/questions/` — the `AskQuestion` type is the wire contract.
2. Per-channel rendering belongs in each channel package's `ask.ts` (or equivalent). The gateway never knows whether the user saw buttons or a select.
3. If your change adds a capability (e.g., file-upload answers), update the `channels.capabilities` schema so the gateway can reject calls to channels that don't support it — never silently drop options.
4. "Other" free-text is mandatory in v1. Don't add a flag to disable it without a very strong reason.

## When adding a protocol method or event

1. Schema in `packages/protocol/src/` first (request, response, event).
2. Handler in `packages/gateway/src/dispatch/<namespace>.ts`.
3. Consumer in whatever client needs it (dashboard, connector).
4. Integration test under `packages/gateway/test/integration/`.

## Things to avoid

- Adding Discord-specific (or any channel-specific) types to the gateway. Channel-ness lives in channel packages.
- Privileging the dashboard. If a feature needs a dashboard-only endpoint, it's a protocol gap — fill the gap, don't carve an exception.
- Introducing a second wire format. JSON-over-WS is the protocol.
- Coupling the dashboard to specific plugins, specific channels, or a hard-coded list of subagent/task/question names — it should render generically off protocol data.
- Premature abstractions for "future channels" — the channel contract is designed from Discord + one paper-prototype second channel. Don't over-generalize further until a real second channel forces the issue.
- Adding subagent, task, or question features to the `chat.*` namespace. Each has its own namespace for a reason.
- Encouraging agents to hand-roll Discord markdown, Block Kit JSON, or HTML. If an agent is building channel markup directly, something is missing from the `tasks.*` / `questions.*` / `subagents.*` primitives — fix that.
- Silently dropping options when a channel can't render everything. Degrade loudly or reject the tool call with a clear error so the agent can re-shape.
- New top-level dependencies without a clear reason; prefer the standard library, what's already in the workspace, and vendoring over adding a dep.
- Reintroducing the old "runtime as separate WS service" pattern. It's cut intentionally.
- Editing a vendored file without updating its header and `VENDOR.md`.

## Status

The ten-phase v1 plan in `PLAN.md` is shipped on `main`. Each package
compiles and tests pass (`pnpm -r build`, `pnpm -r test`). Current
snapshot:

- `@squad/protocol` — every namespace (`session.*`, `chat.*`,
  `subagents.*`, `tasks.*`, `questions.*`, `approvals.*`, `plugins.*`,
  `channels.*`, `routines.*`, `admin.*`) has a Zod schema and a TS type.
- `@squad/runner` / `@squad/llm` / `@squad/tools` — vendored from
  agentic `7daf6df`. See `VENDOR.md`.
- `@squad/gateway` — HTTP + WS + SQLite (migrations 001–005), the full
  dispatch layer, delivery coordinator, subagent pool, plugin host,
  approval policy engine, cron routines, dashboard statics.
- `@squad/client-cli` — reference terminal client + `ProtocolClient`
  reusable shape.
- `@squad/channel-sdk` + `@squad/channel-discord` — SDK with
  reconnecting client, session map, renderer contract. Discord D0+D1
  in; D2 (buttons, task embed, reaction approvals, attachments) is
  scaffolded but not end-to-end — it needs a live test guild.
- `@squad/dashboard` — React + Vite, served by the gateway at `/`.

Explicit gaps worth attention on the next pass:
- Discord D2 (ask-user buttons, pinned task embed, reaction approvals,
  attachments). All the protocol + SDK pieces are in place.
- Approval escalation wiring — the policy engine + `approvals.*`
  dispatch exist but `before_tool_call` isn't wired to escalate yet.
- Routine execution — routines register and fire, but firing only
  creates a session; it doesn't yet push the prompt through
  `runChatTurn` or honor the `delivery` field.
- FTS5 search UI — the index is populated, `session.search` is
  stubbed.

When you add work, update `PLAN.md` to reflect the new shape.
Check `SPEC.md`'s Roadmap section before starting anything new.
