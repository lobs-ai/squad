# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this project is

Squad is an open-source, gateway-centric multi-agent platform. A central **gateway** routes messages, manages sessions, and enforces auth. **Connectors** (Discord, Slack, HTTP, CLI, ...) speak to the gateway over a JSON protocol. **Runtimes** (Ollama, OpenAI-compatible, etc.) run the actual model. See `SPEC.md` for the full design.

## Stack

- **Language:** TypeScript (Node.js 20+)
- **Package manager:** pnpm (workspaces)
- **Transport:** WebSocket + HTTP
- **Container:** Docker / Docker Compose
- **Wire format:** JSON (see Protocol section in `SPEC.md`)

The repo previously had a Go scaffold; it's been removed. All new code is TypeScript.

## Intended layout

Not all of this exists yet — scaffold as needed:

```
squad/
├── packages/
│   ├── gateway/           # Main gateway service
│   ├── protocol/          # Shared wire-protocol types + schemas
│   ├── runtime/           # Agent runtime adapters (ollama, openai, ...)
│   └── connectors/
│       ├── discord/
│       ├── slack/
│       ├── http/
│       └── cli/
├── examples/              # Example configs / compose files
└── docs/
```

Keep packages small and single-purpose. The gateway must not import connector- or platform-specific code; connectors depend on `protocol`, never the other way around.

## Architectural rules (don't break these)

1. **Gateway is the center.** Connectors talk to the gateway, never directly to runtimes or to each other.
2. **Gateway is platform-agnostic.** No Discord/Slack/etc. types or imports inside `packages/gateway`.
3. **Protocol is the contract.** Any new message type goes in `packages/protocol` first, then implementations follow.
4. **Runtimes are pluggable.** New runtime = new adapter implementing the runtime interface. Don't special-case providers in the gateway.
5. **Self-hosting first.** No hardcoded URLs to hosted services, no telemetry-by-default, no vendor lock-in.

## Conventions

- TypeScript strict mode. No `any` without a comment justifying it.
- ESM (`"type": "module"`).
- Prefer `zod` (or similar) for runtime validation at protocol boundaries — wire messages are untrusted input.
- Async/await only; no callback APIs in new code.
- Errors thrown across the wire are serialized via the protocol's error envelope, not raw stack traces.
- Logging via a single shared logger (TBD); never `console.log` in library code.

## Commands

These are the *intended* scripts; some may not exist until the workspace is scaffolded.

```bash
pnpm install        # install workspace deps
pnpm dev            # run gateway in watch mode
pnpm build          # build all packages
pnpm test           # run all tests
pnpm lint           # eslint
pnpm format         # prettier
docker compose up   # full local stack (gateway + ollama + cli connector)
```

If a script you need doesn't exist, add it to the appropriate `package.json` rather than running raw `tsc`/`node` commands.

## Tests

- Unit tests live next to source as `*.test.ts`.
- Integration tests for gateway ↔ connector flows go in `packages/gateway/test/integration/`.
- Don't mock the protocol layer in integration tests — exercise the real WebSocket loop.

## When adding a connector

1. New package under `packages/connectors/<name>/`.
2. Depend on `@squad/protocol` for message types.
3. Implement the connector lifecycle: connect → authenticate → start session → relay messages → handle disconnect/reconnect.
4. Add a Docker profile to `docker-compose.yml`.
5. Document required env vars in the connector's README.

## When adding a runtime

1. New adapter under `packages/runtime/src/adapters/<name>.ts`.
2. Implement the runtime interface from `packages/runtime/src/types.ts`.
3. Register it in the runtime factory.
4. Add a config example to `SPEC.md`'s Configuration section.

## Things to avoid

- Adding platform-specific logic to the gateway.
- Introducing a second wire format. JSON-over-WS is the protocol.
- Coupling connectors to specific runtimes (they should never know what runtime is serving them).
- Premature abstractions for "future runtimes/connectors" — wait until there are two real implementations before generalizing.
- New top-level dependencies without a clear reason; prefer the standard library and existing deps.

## Status

Early development. The gateway core, protocol package, and a CLI connector are the first things to build. Everything in `SPEC.md`'s Roadmap is fair game; check there before starting new work.
