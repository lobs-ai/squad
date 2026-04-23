# Contributing to Squad

Welcome! We're glad you're interested in contributing.

## Getting Started

1. Fork the repository.
2. Clone your fork: `git clone git@github.com:your-username/squad.git`
3. Install Node.js 20+ and pnpm.
4. `pnpm install`
5. Build everything once: `pnpm build`
6. Start the gateway in watch mode: `pnpm dev`

## Project Structure

```
squad/
├── packages/
│   ├── gateway/            # WS + HTTP server, dispatch, storage, subagent pool,
│   │                       # task + question stores, plugin host
│   ├── protocol/           # Wire types + Zod schemas (the contract)
│   ├── runner/             # Vendored agent loop (see VENDOR.md)
│   ├── llm/                # Vendored LLMClient + providers
│   ├── tools/              # BaseTool + registry + built-ins
│   ├── plugin-sdk/         # definePlugin() contract
│   ├── channel-sdk/        # Shared runtime for channels + renderer contract
│   ├── channel-discord/    # First-party Discord channel
│   ├── client-cli/         # Reference terminal client
│   └── dashboard/          # React + Vite web UI
├── extensions/             # User-authored plugins
├── examples/
│   ├── compose.yml                  # default: one service, Discord in-process
│   ├── compose.split-channels.yml   # opt-in: gateway + Discord as separate services
│   └── subagents/                   # starter subagent definitions
├── VENDOR.md               # pinned source commits for files copied from lobs/agentic
├── SPEC.md                 # full design
├── PLAN.md                 # implementation plan
└── AGENTS.md               # guidance for AI coding agents
```

## Adding a channel

Channels are plugins. Copy `packages/channel-discord` as a template:

1. Depend on `@squad/channel-sdk` and `@squad/protocol`.
2. Implement `renderTaskList`, `handleTaskAction`, `renderAsk`, and declare your `capabilities`.
3. Register via `definePlugin({ kinds: ["channel"], ... })`.
4. Ship either as an in-gateway plugin or as a standalone process (the SDK supports both).

## Protocol

Squad uses JSON over WebSocket. Every method and event has a Zod schema in `packages/protocol`. New wire messages **start** with a schema — if it isn't in the protocol, it doesn't exist.

See `SPEC.md` for the full specification.

## Code Style

- TypeScript strict. No `any` without a justifying comment.
- ESM everywhere.
- Run `pnpm lint` and `pnpm format` before committing.
- Add tests for new functionality; integration tests exercise the real WS loop (no protocol-layer mocks).

## Questions?

Open an issue.
