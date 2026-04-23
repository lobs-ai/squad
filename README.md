# Squad

**A self-hostable agent platform that plugs into any communication channel, with a proper dashboard and a plugin system.**

Squad runs one gateway process that owns sessions, the agent loop, plugins, and storage. Channels — Discord, Slack, Telegram, SMS, email, voice, IDE bridges — all connect to it over the same WebSocket protocol. The dashboard is just another client of that same protocol. Drop in plugins to add tools, LLM providers, skills, or new channels.

**Discord is the first channel we ship.** The channel contract is built for anything, but we're proving it end-to-end with Discord first and adding more channels as plugins after v1.

v1 is deliberately narrow where it counts: one shipped channel (Discord), one database (SQLite), one deployment (Docker Compose). For LLMs we ship **every provider agentic supports** out of the box — Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, OpenRouter, Together, xAI, Perplexity, Fireworks, Cerebras, Cohere, SambaNova, Novita, Hyperbolic, Lambda, Ollama, LM Studio, llama.cpp, vLLM, and a few more — so you can run your agent on whatever model you prefer from day one. Everything beyond the core is a plugin.

## Quick start

```bash
git clone https://github.com/lobs-ai/squad.git
cd squad
cp examples/config.yaml ./config.yaml
cp examples/.env.example ./.env          # ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, ...
docker compose up
```

Open the dashboard at http://localhost:8080 and your agent is live in the Discord channel you configured.

## How it works

```
Channels (Discord, Slack, Email, SMS, ...) ─┐
                                            ├──WS──▶  Gateway  ──▶  Runner (agent loop)  ──▶  LLM + Tools
                                  Dashboard ─┘                   ──▶  SQLite (sessions, approvals, routines)
                                                                 ──▶  Plugin host
```

- **Gateway** — one long-running process. Owns the wire protocol, sessions, storage, and plugin loading. Channel-agnostic.
- **Runner** — the agent loop, vendored from [`lobs/agentic`](https://github.com/lobs-ai/agentic). Copied into `packages/runner`, not imported.
- **Channels** — each communication medium implements the same channel contract. Discord is the first-party reference channel; others come as plugins.
- **Dashboard** — React + Vite. Lives at `/` on the gateway. Live chat, session search, tool-approval queue, plugin manager, channel status, routine scheduler.
- **Plugins** — tools, providers, channels, skills, and routines all register through one `definePlugin({...})` contract.

See [SPEC.md](SPEC.md) for the full design.

## What's in v1

- A channel-agnostic gateway with the full channel contract
- **Discord as the first shipped channel** (see the [Discord Implementation Plan](SPEC.md#discord-implementation-plan))
- **Every LLM provider agentic supports** — Anthropic (default), OpenAI, Google, OpenRouter, Groq, DeepSeek, Mistral, Together, xAI, Perplexity, Fireworks, Cerebras, Cohere, SambaNova, Novita, Hyperbolic, Lambda, Ollama, LM Studio, llama.cpp, vLLM, z-ai, Minimax, Kimi, opencode, plus an `openai-compatible` escape hatch
- A minimal built-in tool set (read/write/list/fetch/search)
- SQLite session persistence with FTS5 search
- Approval queue for tools tagged `write` / `exec` / `network`
- Cron-scheduled routines
- Plugin API for tools, providers, channels, skills, routines

Explicitly **not** in v1: other first-party channels (Slack, Telegram, email, voice, ...), Kubernetes, multi-user, plugin sandboxing, a marketplace. See the [SPEC](SPEC.md#what-v1-is-not) for why.

## Status

Early development. The current repo is the design; packages under `packages/` are being scaffolded.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
