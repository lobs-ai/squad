# Contributing to Squad

Welcome! We're glad you're interested in contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone git@github.com:your-username/squad.git`
3. Install Node.js 20+ and pnpm
4. Run `pnpm install`
5. Start the gateway: `pnpm dev`

## Project Structure

```
squad/
├── packages/
│   ├── gateway/           # Main gateway service
│   ├── protocol/          # Wire protocol types
│   ├── runtime/           # Agent runtime adapters
│   └── connectors/
│       ├── discord/       # Discord connector
│       ├── slack/         # Slack connector
│       └── cli/           # CLI connector
├── examples/              # Example configurations
└── docs/                  # Documentation
```

## Adding a Connector

1. Create a new package under `packages/connectors/yourplatform/`
2. Implement the connector interface (see `packages/protocol/`)
3. Add Docker profile to `docker-compose.yml`
4. Submit a PR

## Protocol

Squad uses a simple JSON protocol over WebSocket. See `SPEC.md` for the full specification.

## Code Style

- Run `pnpm lint` and `pnpm format` before committing
- Add tests for new functionality
- Update documentation as needed

## Questions?

Open an issue or reach out on Discord.
