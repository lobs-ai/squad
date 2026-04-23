# Squad

**The open-source, gateway-centric multi-agent platform.**

Squad makes it easy to build, deploy, and manage AI agents that connect to everything. A central gateway handles sessions, routing, and authentication — while connectors bring agents to Discord, Slack, your API, and more.

## Quick Start

### Docker (Recommended)

```bash
docker run -p 8080:8080 \
  -e SQUAD_AUTH_API_KEY=your-key-here \
  squad-ai/squad-gateway
```

### Docker Compose

```bash
git clone https://github.com/lobs-ai/squad.git
cd squad
docker compose up
```

### Build from Source

```bash
go build -o squad-gateway ./cmd/gateway
./squad-gateway --config config.yaml
```

## How It Works

```
Connector (Discord, Slack, API...) → Gateway → Agent Runtime (Ollama, OpenAI...)
```

- **Gateway** — The brain. Manages sessions, routes messages, enforces auth.
- **Connectors** — Adapters for each platform. One agent, many faces.
- **Runtimes** — Where the AI actually runs. Swap models without changing anything else.

## Architecture

Squad is built around one core principle: **the gateway is the center of everything**.

- Connectors connect to the gateway, not to agents directly
- The gateway manages all session state
- Runtimes are pluggable — use Ollama, OpenAI, or roll your own
- Everything communicates over a clean WebSocket/HTTP protocol

This means you can:
- Run a Discord bot and a Slack bot with the same agent
- Swap Discord for Slack by swapping the connector
- Deploy connectors anywhere — same machine or different servers
- Build new connectors without touching the core

## Features

- **Gateway-centric design** — Session management, routing, and auth in one place
- **Docker-first** — One command to run everything
- **Connector ecosystem** — Discord, Slack, HTTP, CLI, and more
- **Pluggable runtimes** — Ollama, OpenAI-compatible APIs, custom runtimes
- **Open protocol** — Build connectors in any language
- **Self-hostable** — Your infrastructure, your data

## Status

Early development. Gateway core and basic connectors in progress.

See [SPEC.md](SPEC.md) for the full design specification.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
