# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this project is

Squad is a self-hostable agent platform designed to plug into **any communication channel**. One **gateway** process owns sessions, the agent loop, plugins, and storage. Channels (Discord, Slack, Telegram, SMS, email, voice, webhooks, IDE bridges) all implement the same channel contract and connect over the same WebSocket wire protocol as the **React dashboard** (served by the gateway). See `SPEC.md` for the full design.

v1 ships exactly one first-party channel — **Discord** — to prove the contract end-to-end. The gateway itself is channel-agnostic; Discord is not special. Other channels come as plugins after v1. See the [Discord Implementation Plan](SPEC.md#discord-implementation-plan) in `SPEC.md` for the concrete build.

**LLM providers:** v1 ships every provider the vendored `packages/llm` supports (all of agentic's providers — anthropic, openai, openrouter, google, groq, deepseek, mistral, together, xai, perplexity, fireworks, cerebras, cohere, sambanova, novita, hyperbolic, lambda, ollama, lmstudio, llamacpp, vllm, z-ai, minimax, kimi, opencode-zen, opencode-go, plus the `openai-compatible` escape hatch). They all run through three client implementations: native Anthropic, native OpenAI, and a shared OpenAI-compatible client. The default model is Anthropic but any installed provider is usable per-session.

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
│   ├── gateway/            # WS/HTTP server, dispatch, plugin host, storage
│   ├── runner/             # Agent loop (VENDORED from ../agentic — do not add as dep)
│   ├── llm/                # LLMClient + Anthropic provider (VENDORED from ../agentic)
│   ├── tools/              # BaseTool + registry + built-in tools
│   ├── protocol/           # Wire types + Zod schemas
│   ├── plugin-sdk/         # definePlugin() contract for extension authors
│   ├── channel-sdk/        # Shared runtime for channel processes (WS client, retry, session map)
│   ├── channel-discord/    # First-party Discord channel (separate process)
│   └── dashboard/          # React + Vite web UI
├── extensions/             # User-authored plugins
├── examples/
└── docs/
```

Keep packages single-purpose. The gateway must not import Discord or dashboard code; connectors and the dashboard depend on `@squad/protocol`, never the other way around.

## Architectural rules (don't break these)

1. **Gateway is the center.** Channels and the dashboard talk to the gateway, never directly to each other or to runtimes.
2. **Gateway is channel-agnostic.** No `discord.js` (or `slack`, `telegram`, `nodemailer`, etc.) imports in `packages/gateway`. Channel knowledge lives in `packages/channel-<name>` or in channel plugins.
3. **Protocol is the contract.** Every new message type goes in `packages/protocol` with a Zod schema first, then implementations follow. If it's not in the protocol, it doesn't exist.
4. **Runner and LLM are vendored.** `packages/runner` and `packages/llm` are copied from `lobs/agentic`. Don't add `@agentic/*` as dependencies. Do evolve the copies freely.
5. **Plugins are the extension mechanism.** New tools, LLM providers, channels, skills, or routines go through `definePlugin()`. Resist adding special cases in the gateway for specific plugins or specific channels (including Discord).
6. **One process, one agent loop.** v1 runs `runAgent()` in-process in the gateway. No "runtime service" over WS. This was cut from the older design deliberately — don't bring it back without a real reason.
7. **Self-hosting first.** No hosted-service URLs, no telemetry, no phone-home. Config points at user-provided credentials only.

## What to vendor from `../agentic`

Copy these files into `packages/runner/src/` and `packages/llm/src/` (paths relative to `/Users/rafe/other/lobs/agentic`):

**Must-have:**
- `packages/runner/src/agent-loop.ts`
- `packages/runner/src/types.ts`
- `packages/runner/src/hooks.ts`
- `packages/runner/src/loop-detector.ts`
- `packages/runner/src/context-engine.ts`
- `packages/llm/src/types.ts`
- `packages/llm/src/client.ts` — includes `parseModelString()`, `inferProvider()`, the full `KNOWN_PROVIDERS` list, and the `createClient()` factory that dispatches to the right provider implementation.
- `packages/llm/src/providers/anthropic.ts` — native Anthropic SDK.
- `packages/llm/src/providers/openai.ts` — native OpenAI SDK (also serves `openai-codex`).
- `packages/llm/src/providers/openai-compatible.ts` — shared OpenAI-compatible client that backs every remaining provider (openrouter, google, groq, deepseek, mistral, together, xai, perplexity, fireworks, cerebras, cohere, sambanova, novita, hyperbolic, lambda, ollama, lmstudio, llamacpp, vllm, z-ai, minimax, kimi, opencode-zen, opencode-go, openai-compatible).
- `packages/tools/src/base-tool.ts`
- `packages/tools/src/registry.ts`

**Skip:** agentic's `session.ts` (we use our own SQLite session store) and the runtime layer. Take the full provider set — v1 ships all of them.

When vendoring, preserve the file's original header as a comment noting the source commit — makes future re-sync easier.

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
docker compose up   # full local stack (gateway + discord)
```

If a script you need doesn't exist, add it to the appropriate `package.json` rather than running raw `tsc`/`node` commands.

## Tests

- Unit tests live next to source as `*.test.ts`.
- Integration tests for gateway ↔ connector / gateway ↔ dashboard flows go in `packages/gateway/test/integration/`.
- Don't mock the protocol layer in integration tests — exercise the real WebSocket loop.
- When testing tools, use the real tool registry, not a stub.

## When adding a tool

1. Extend `BaseTool` in the owning package (usually `packages/tools/src/<tool>.ts`, or a plugin).
2. Give it accurate `tags` — they drive approval policy.
3. If it's a built-in, register it in the default registry factory. If it's a plugin, register it in the plugin's `register()`.

## When adding a plugin kind

1. Add the kind to `packages/plugin-sdk/src/types.ts`.
2. Add a registration API on `GatewayAPI` (e.g. `api.tools.register`).
3. Implement the host side in `packages/gateway/src/plugins/`.
4. Document the kind in `SPEC.md`.

## When adding a protocol method or event

1. Schema in `packages/protocol/src/` first (request, response, event).
2. Handler in `packages/gateway/src/dispatch/<namespace>.ts`.
3. Consumer in whatever client needs it (dashboard, connector).
4. Integration test under `packages/gateway/test/integration/`.

## Things to avoid

- Adding Discord-specific (or any channel-specific) types to the gateway. Channel-ness lives in channel packages.
- Introducing a second wire format. JSON-over-WS is the protocol.
- Coupling the dashboard to specific plugins or specific channels — it should render generically off protocol data.
- Premature abstractions for "future channels" — the channel contract is designed from Discord + one paper-prototype second channel. Don't over-generalize further until a real second channel forces the issue.
- New top-level dependencies without a clear reason; prefer the standard library, what's already in the workspace, and vendoring over adding a dep.
- Reintroducing the old "runtime as separate WS service" pattern. It's cut intentionally.

## Status

Early development. Priority order:

1. `@squad/protocol` (unblocks everything else)
2. `@squad/runner` + `@squad/llm` + `@squad/tools` (vendor from agentic)
3. `@squad/gateway` skeleton (WS server, dispatch, SQLite, one method: `chat.send`)
4. `@squad/channel-sdk` + `@squad/channel-discord` (prove the end-to-end loop with the first channel)
5. `@squad/dashboard` (chat view first, then approvals, then the rest)
6. Plugin host + one example plugin per kind
7. Routines

Check `SPEC.md`'s Roadmap section before starting new work.
