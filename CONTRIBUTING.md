# Contributing to Squad

Welcome! We're glad you're interested in contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone git@github.com:your-username/squad.git`
3. Install Go 1.23+
4. Run `go mod tidy`
5. Start the gateway: `go run ./cmd/gateway`

## Project Structure

```
squad/
├── cmd/                    # Entry points
│   ├── gateway/           # Main gateway service
│   ├── connector-discord/ # Discord connector
│   └── connector-slack/    # Slack connector
├── internal/              # Internal packages
│   ├── gateway/          # Gateway implementation
│   ├── protocol/         # Wire protocol
│   ├── runtime/           # Agent runtime adapters
│   └── connector/         # Connector base
├── pkg/                   # Public packages
│   └── models/           # Shared data structures
├── examples/             # Example configurations
└── docs/                 # Documentation
```

## Adding a Connector

1. Create a new package under `cmd/connector-yourplatform/`
2. Implement the connector interface (see `internal/connector/`)
3. Add Docker profile to `docker-compose.yml`
4. Submit a PR

## Protocol

Squad uses a simple JSON protocol over WebSocket. See `SPEC.md` for the full specification.

## Code Style

- Run `go fmt` before committing
- Add tests for new functionality
- Update documentation as needed

## Questions?

Open an issue or reach out on Discord.
