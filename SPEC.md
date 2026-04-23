# Squad — Design Specification

## Overview

Squad is an open-source, gateway-centric multi-agent orchestration platform. Anyone can run it. Connectors plug into a central gateway that routes, authenticates, and manages agent sessions. Think of it as the "rails" that agent communication runs on.

**Why this architecture:** The gateway is the single source of truth for session state, authentication, routing, and policy. Everything else — Discord connectors, Slack bots, API clients, webhooks — is a connector that speaks to the gateway. This means:
- You can swap Discord for Slack by swapping the connector
- You can run one connector or many
- You can extend anything without touching the core
- Self-hosting is a first-class concern, not an afterthought

---

## Core Concepts

### The Gateway

The gateway is the heart of Squad. It's a long-running service that:
- Accepts incoming connections from connectors over WebSocket or HTTP
- Manages agent sessions (create, resume, terminate)
- Routes messages between connectors and agent runtimes
- Enforces authentication and access policies
- Exposes a clean API for connectors to interact with

The gateway does NOT:
- Run agents itself (delegates to agent runtimes)
- Know anything about Discord, Slack, or any specific platform
- Make assumptions about the hosting environment

### Agent Runtimes

Agent runtimes are where the actual AI work happens. The gateway sends prompts to runtimes and receives responses. Runtimes can be:
- Local (Ollama, LM Studio)
- Cloud APIs (OpenAI, Anthropic, Groq, etc.)
- Custom-built runtimes

The gateway and runtimes communicate over a well-defined protocol. You can swap runtimes without touching connectors.

### Connectors

Connectors are the "faces" of your agents. They handle platform-specific communication:

| Connector | Purpose |
|-----------|---------|
| `connector-discord` | Discord bot integration |
| `connector-slack` | Slack app integration |
| `connector-http` | REST API client (web dashboards, mobile apps) |
| `connector-cli` | Terminal interface |
| `connector-webhook` | Outbound webhooks for events |

Connectors are separate processes that connect to the gateway. They can run anywhere — same machine, different servers, whatever makes sense for your deployment.

### Sessions

A session is a conversation context. When a user starts talking to a connector, the connector opens a session with the gateway. The gateway routes to the appropriate runtime and maintains context.

Sessions are identified by a UUID and carry:
- User identity (who is talking to the agent)
- Metadata (channel, platform, timestamp)
- Context window (recent messages)

---

## Architecture

```
┌──────────────┐     WebSocket/HTTP     ┌────────────────────┐
│  Connector   │◄──────────────────────►│                    │
│  (Discord)   │                        │      Gateway       │
└──────────────┘                        │                    │
┌──────────────┐     WebSocket/HTTP     │  - Auth            │
│  Connector   │◄──────────────────────►│  - Sessions        │
│  (Slack)     │                        │  - Routing         │
└──────────────┘                        │  - Policy           │
                                       └────────┬───────────┘
                                                │
                                       Protocol │ (gateway-runtime protocol)
                                                │
                                       ┌────────▼───────────┐
                                       │   Agent Runtime    │
                                       │   (Ollama, API)    │
                                       └────────────────────┘
```

---

## Protocol

### Gateway ↔ Runtime

Communication happens over WebSocket. The protocol is JSON-based:

**Request:**
```json
{
  "type": "request",
  "id": "uuid",
  "action": "complete",
  "session_id": "uuid",
  "payload": {
    "messages": [...],
    "system_prompt": "..."
  }
}
```

**Response:**
```json
{
  "type": "response",
  "id": "uuid",
  "status": "ok",
  "payload": {
    "completion": "..."
  }
}
```

### Gateway ↔ Connector

Same protocol, different actions. Connectors can:
- `session.start` — begin a new session
- `session.send` — send a message
- `session.end` — close a session
- `session.list` — list active sessions (admin)

---

## Deployment

### Docker (Recommended)

The gateway ships as a Docker image. One command to get started:

```bash
docker run -p 8080:8080 squad-ai/squad-gateway
```

Docker Compose for local development:
```bash
docker compose up
```

### Kubernetes

Helm chart for production deployments. See `examples/kubernetes/`.

### Bare Metal

The gateway is a single binary (Go). Download and run:
```bash
./squad-gateway --config config.yaml
```

---

## Configuration

Configuration is via `config.yaml`:

```yaml
server:
  host: 0.0.0.0
  port: 8080
  auth:
    type: api_key
    keys:
      - "your-api-key-here"

runtimes:
  default:
    type: ollama
    url: http://localhost:11434
    model: llama3.2

connectors:
  enabled: true
  allowed_origins:
    - "http://localhost:3000"
```

---

## Goals

1. **Zero-config defaults** — It works out of the box. Sensible defaults for everything.
2. **Docker-first** — You can run everything in Docker with one command.
3. **Connector ecosystem** — Anyone can build a connector. The protocol is open.
4. **Self-hostable** — No vendor lock-in. Your data stays on your infrastructure.
5. **Multi-agent ready** — The gateway naturally supports multiple simultaneous sessions.

---

## What We're NOT

- Not an agent itself. Squad is infrastructure, not an AI.
- Not a code interpreter. That's the runtime's job.
- Not a hosted service. We provide the software; you host it.
- Not opinionated about LLMs. Use any model you want.

---

## Competitive Position

| Feature | OpenClaw | Hermes | Squad |
|---------|----------|--------|-------|
| Gateway-centric | ❌ | ❌ | ✅ |
| Multi-connector | ❌ | ❌ | ✅ |
| First-class Docker | ⚠️ | ✅ | ✅ |
| Self-hostable | ✅ | ✅ | ✅ |
| Multi-user/team | ❌ | ❌ | ✅ |
| Open protocol | ❌ | ⚠️ | ✅ |

---

## Roadmap

- [ ] Gateway core (session management, routing, auth)
- [ ] HTTP/WebSocket connector
- [ ] CLI connector
- [ ] Ollama runtime adapter
- [ ] OpenAI-compatible runtime adapter
- [ ] Docker Compose setup
- [ ] Basic web dashboard
- [ ] Discord connector
- [ ] Slack connector
- [ ] Kubernetes Helm chart
- [ ] Skills/memory system
- [ ] Team/multi-user support
- [ ] Marketplace for community connectors

---

## License

MIT
