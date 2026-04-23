# `docker/` — host-side state

This folder is the single bind-mount surface for the gateway container. Everything Squad needs to keep across restarts lives here:

| File / dir          | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `config.json`       | Runtime config (server, auth, llm, subagents, policy, plugins).    |
| `.env`              | Secrets: `ANTHROPIC_API_KEY`, `SQUAD_DASHBOARD_TOKEN`, etc.        |
| `data/`             | SQLite database, FTS5 index, and any uploaded attachments.         |

All contents except this README and `.gitkeep` are **gitignored**. Treat `.env` like a password file.

## Generating the contents

```bash
pnpm setup            # interactive wizard — writes config.json + .env
```

Re-run any time to add a provider, change ports, or rotate the dashboard token. The wizard preserves any unknown keys you added by hand.

## Choosing models

`config.json` names a **primary** model plus an ordered list of **fallbacks**:

```json
"llm": {
  "primary":  { "model": "anthropic/claude-sonnet-4-5" },
  "fallbacks": [
    { "model": "openai/gpt-4o" },
    { "model": "google/gemini-2.0-flash" }
  ],
  "providers": {
    "anthropic": { "api_key_env": "ANTHROPIC_API_KEY" },
    "openai":    { "api_key_env": "OPENAI_API_KEY" },
    "google":    { "api_key_env": "GOOGLE_API_KEY" }
  }
}
```

If the primary fails with a transient error (rate limit, 5xx, timeout, network), the runner advances to the next model in the chain and **sticks there for the rest of the session** — no silent drops back to the primary mid-conversation. Auth and invalid-request failures bypass the chain. The dashboard's "New session" panel lets a user override the chain for a single session.

## How it gets into the container

`docker-compose.yml` bind-mounts the whole folder:

```yaml
volumes:
  - ./docker:/app/docker
environment:
  - SQUAD_CONFIG=/app/docker/config.json
env_file:
  - ./docker/.env
```

For local runs (`pnpm start:local`), the same path resolves relative to the repo root — same files, same data.
