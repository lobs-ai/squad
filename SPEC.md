# Squad — Design Specification

## Overview

Squad is a self-hostable agent platform designed to live in **any communication channel** — chat apps, email, SMS, voice, webhooks, IDEs — alongside a local web dashboard. A single **gateway** process owns everything — sessions, tool execution, plugin loading, the WebSocket/HTTP surface — and every communication channel plugs into it through the same **channel** contract.

Channels are the extension story for "how users talk to agents". **Discord is the first channel we ship** because it's a clean, well-documented target that proves the abstraction end-to-end. Anything we learn building it should shape the channel contract; anything Discord-specific stays in the Discord package.

The design target for v1 is **stability and focus**: one shipped channel to start (Discord), one storage engine (SQLite), one deployment story (Docker Compose). For LLMs we ship every provider the vendored agent loop supports out of the box — Anthropic, OpenAI, and ~24 OpenAI-compatible endpoints — so users aren't locked to a single model vendor on day one. Anything beyond this core — additional channels, tools, skills, scheduled routines, new providers — is a plugin.

**Influences.** Squad borrows the gateway/plugin/broadcast pattern from OpenClaw, the command-registry and session-persistence patterns from hermes-agent, and vendors its agent loop from [`lobs/agentic`](../agentic) — we copy the files into `packages/runner` and `packages/llm` rather than taking a dependency on the library.

---

## Design Principles

1. **One process, one deploy.** The gateway runs the agent loop in-process. No separate "runtime service", no cross-process RPC for normal turns. Fewer moving parts = more stable.
2. **Any channel, any time.** The gateway is channel-agnostic. Discord, Slack, Telegram, SMS, email, voice, webhooks, IDE plugins — they all implement the same **channel** contract. Squad ships Discord as the reference channel; the rest are plugins.
3. **Plugins are the extension story.** Tools, LLM providers, channels, skills, and routines are all plugins with a single, uniform entry contract.
4. **The dashboard is a first-class client.** It connects to the gateway over WebSocket using the same protocol as every channel. Nothing special about being "the UI".
5. **Vendor the agent loop.** `packages/runner` and `packages/llm` are copied from agentic, not imported. Squad owns them outright and can evolve them freely.
6. **Self-host by default.** No telemetry, no hosted backend, no cloud-only features. Your data, your channels, your machine.

---

## Architecture

```
┌─────────────────────┐        ┌───────────────────────────────────────┐
│   Channel: Discord  │───WS──▶│                                       │
│   Channel: Slack    │───WS──▶│               Gateway                 │
│   Channel: Email    │───WS──▶│                                       │
│   Channel: …        │───WS──▶│  ┌─────────────┐  ┌────────────────┐  │
└─────────────────────┘        │  │  Dispatch   │  │  Plugin Host   │  │
┌─────────────────────┐        │  │ (namespaced │  │ (load, init,   │  │
│    Web Dashboard    │───WS──▶│  │  handlers)  │  │  hook, unload) │  │
│   (React + Vite)    │◀──WS───│  └──────┬──────┘  └────────┬───────┘  │
└─────────────────────┘        │         │                  │          │
                               │  ┌──────▼──────────────────▼───────┐  │
                               │  │       Runner (agent loop)       │  │
                               │  │  runAgent() ⇒ LLM + tool calls  │  │
                               │  └──────┬──────────────────┬───────┘  │
                               │         │                  │          │
                               │  ┌──────▼──────┐   ┌───────▼──────┐   │
                               │  │   LLM       │   │  Tools       │   │
                               │  │  (Anthropic)│   │  (registry)  │   │
                               │  └─────────────┘   └──────────────┘   │
                               │                                       │
                               │  ┌───────────────────────────────┐    │
                               │  │   SQLite (sessions, approvals,│    │
                               │  │   routines, transcripts)      │    │
                               │  └───────────────────────────────┘    │
                               └───────────────────────────────────────┘
```

Channels and the dashboard are all **clients** of the gateway. They open a WebSocket, authenticate, subscribe to the scopes they care about, and send/receive the same JSON messages. The gateway runs the agent loop in-process and streams results back to whichever clients asked for them. The gateway never needs to know *which* channel it's talking to — only that something on the other side speaks the channel protocol.

---

## Packages

```
squad/
├── packages/
│   ├── gateway/            # HTTP + WS server, dispatch, plugin host, storage
│   ├── runner/             # Agent loop (vendored from agentic)
│   ├── llm/                # LLMClient interface + Anthropic provider (vendored)
│   ├── tools/              # BaseTool, ToolRegistry, built-in tools
│   ├── protocol/           # Wire types + Zod schemas (shared by all clients)
│   ├── plugin-sdk/         # definePlugin() contract, types for extension authors
│   ├── channel-sdk/        # Shared runtime for channel processes (WS client, retry, session mapping)
│   ├── channel-discord/    # First-party Discord channel (separate process)
│   └── dashboard/          # React + Vite web UI
├── extensions/             # User-authored plugins (tools, channels, providers...)
├── examples/               # docker-compose.yml, config.yaml, starter extensions
└── docs/
```

### `@squad/gateway`

The long-running server. Responsibilities:

- HTTP surface: health, `/auth`, static dashboard assets, REST for admin ops (optional).
- WebSocket surface: the wire protocol — every client connects here.
- **Dispatch**: namespaced RPC handlers (`session.*`, `chat.*`, `plugins.*`, `routines.*`, `approvals.*`, `admin.*`). New namespaces go in `gateway/src/dispatch/<namespace>.ts`.
- **Broadcast**: event stream with scoped subscriptions. Clients subscribe to e.g. `chat.*` for a specific session; the gateway only delivers what their token authorizes.
- **Plugin host**: discovers plugins on startup, calls each plugin's `register()` with a `GatewayAPI` handle, tears them down cleanly on shutdown/reload.
- **Agent execution**: wraps `runAgent()` from `@squad/runner`. Each incoming user message produces a run; streaming text and tool activity broadcast as events.
- **Storage**: a single SQLite database (via `better-sqlite3` or `bun:sqlite`) for sessions, messages, approvals, routines, and transcripts. FTS5 for session search.

### `@squad/runner` *(vendored from agentic)*

Copy these files from `/Users/rafe/other/lobs/agentic/packages/runner/src/`:

- `agent-loop.ts` — the core loop: build system prompt, call LLM, parse tool-use blocks, execute in parallel, append results, repeat until `end_turn` or limits hit.
- `types.ts` — `AgentSpec`, `AgentResult`, `ToolResult`, timeouts, token accounting.
- `hooks.ts` — `before_agent_start`, `before/after_llm_call`, `before/after_tool_call`, `after_agent_end`. The gateway registers hooks for logging, approval gating, and event broadcasting.
- `context-engine.ts` — pluggable context compaction.
- `loop-detector.ts` — flags repetitive tool calls so the model can recover.

We drop agentic's `session.ts` (we use our own SQLite session store) and any runner-layer config discovery.

### `@squad/llm` *(vendored from agentic)*

- `types.ts` — `LLMClient`, `LLMMessage`, `LLMResponse`, `ContentBlock`, `ToolDefinition`.
- `client.ts` — `parseModelString()`, `inferProvider()`, `createClient()`. Accepts either `"provider/model-id"` or a bare model id that maps to a provider via well-known prefixes (`claude-*` → anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → openai, `gemini-*` → google, `deepseek-*` → deepseek, `mistral-*` / `mixtral-*` / `codestral-*` → mistral, `llama-*` / `gemma-*` / `qwen-*` → groq, `grok-*` → xai, `sonar-*` / `r1-*` → perplexity, `command-*` / `embed-*` → cohere, `ollama:*` → ollama).
- `providers/anthropic.ts` — native Anthropic SDK.
- `providers/openai.ts` — native OpenAI SDK (also serves `openai-codex`).
- `providers/openai-compatible.ts` — shared OpenAI-compatible client used for every other provider below.

**All providers ship in v1** (same list agentic supports):

| Category            | Providers                                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------------------------|
| Native SDK          | `anthropic`, `openai`, `openai-codex`                                                                           |
| Cloud aggregator    | `openrouter`                                                                                                    |
| Frontier labs       | `deepseek`, `mistral`, `groq`, `together`, `xai`, `perplexity`, `fireworks`, `cerebras`, `cohere`               |
| Google              | `google`                                                                                                        |
| Scale/edge          | `sambanova`, `novita`, `hyperbolic`, `lambda`                                                                   |
| Local / self-hosted | `ollama`, `lmstudio`, `llamacpp`, `vllm`                                                                        |
| Other               | `z-ai`, `minimax`, `kimi`, `opencode-zen`, `opencode-go`                                                        |
| Escape hatch        | `openai-compatible` (requires a `baseUrl` in config — works against any OpenAI-compatible endpoint)             |

Local providers (`ollama`, `lmstudio`, `llamacpp`, `vllm`) don't require an API key. Every other provider reads `<PROVIDER>_API_KEY` from the environment unless overridden in `config.yaml`.

**Default model** is Anthropic (`claude-sonnet-4-6`), but any installed provider is usable per-session. Sessions, routines, and plugins can specify their own model string. Further providers (a brand-new vendor, a custom fine-tuned endpoint with special auth, etc.) still come as plugins that register an additional `LLMClient`.

### `@squad/tools`

- `base-tool.ts` + `registry.ts` — vendored from agentic.
- A minimal built-in set: `read_file`, `write_file`, `list_directory`, `web_search` (if a search API key is configured), `fetch_url`. Everything else ships as a plugin.
- Tools can declare `tags: ["readonly" | "write" | "exec" | "network"]`. The gateway uses tags to drive the approval policy.

### `@squad/protocol`

Shared TypeScript types + Zod schemas for every wire message. The gateway, the Discord connector, and the dashboard all depend on this package — nothing else. If a new message type doesn't have a schema here, it doesn't exist.

### `@squad/plugin-sdk`

The public contract for plugin authors.

```ts
import { definePlugin } from "@squad/plugin-sdk";

export default definePlugin({
  id: "my-cool-tool",
  name: "My Cool Tool",
  version: "0.1.0",
  kinds: ["tool"],
  register(api) {
    api.tools.register(new MyCoolTool());
    api.hooks.on("after_tool_call", ({ toolName }) => {
      api.logger.info(`ran ${toolName}`);
    });
    return () => { /* optional cleanup */ };
  },
});
```

Plugin kinds supported in v1:

| Kind      | What it registers                                  |
|-----------|----------------------------------------------------|
| `tool`    | New tools the agent can call                       |
| `provider`| New `LLMClient` implementations                    |
| `channel` | New platform adapters (gives Discord no privilege) |
| `skill`   | Prompt snippets / memory injections                |
| `routine` | Cron-scheduled agent runs                          |

A plugin can be any of these (or several) — `kinds` is an array.

### `@squad/channel-sdk`

A small library that every out-of-process channel depends on. Handles:

- WebSocket connect / auth / reconnect / backoff against the gateway.
- Session mapping: `(platform, remote_id) → session_id`, persisted to a local file so a restart doesn't orphan conversations.
- Event subscription helpers and typed wrappers over `@squad/protocol`.
- A `Channel` base class with the lifecycle hooks every channel implements:
  `connect()`, `onInboundMessage(msg)`, `sendOutbound(sessionId, content)`, `onApprovalRequest(req)`, `disconnect()`.

Community channels can either (a) be an out-of-process package that depends on `@squad/channel-sdk`, or (b) be an in-gateway plugin of kind `channel` — see the plugin kinds table below. The protocol is identical either way; the only difference is process boundary.

### `@squad/channel-discord`

The first-party Discord channel — see the [Discord Implementation Plan](#discord-implementation-plan) section for details. It is the reference implementation of a channel and the shape new channels should follow.

Running channels as **separate processes** by default is deliberate: a crash in one channel shouldn't take down the gateway or the others, and you should be able to bring channels up/down independently. In-gateway channel plugins are supported for early-stage or lightweight channels (webhooks, local CLI, IDE bridges) where a dedicated process is overkill.

### `@squad/dashboard`

React + Vite. Served by the gateway (static assets) or run standalone during development.

Views:

- **Chat** — live conversation view per session, streaming assistant text, inline tool activity, images.
- **Sessions** — list/search (FTS5) across all sessions; jump to any transcript.
- **Approvals** — queue of pending tool-call approvals (anything tagged `write`/`exec`/`network` by policy). Approve/deny with reason.
- **Plugins** — installed list, status, reload/disable, per-plugin config.
- **Channels** — Discord channel routing, bot status, per-channel agent config.
- **Routines** — cron-scheduled runs; view next-fire times and last run output.
- **Logs** — gateway + plugin logs, filterable.
- **Settings** — models, API keys, storage location.

It talks to the gateway over WebSocket and does **nothing the protocol doesn't already expose** — so any third-party UI can do the same.

---

## Wire Protocol

Frames are JSON objects over WebSocket. Every frame has a `type` and an `id` (for request/response correlation).

### Frame types

```ts
// Request: client → gateway
{ type: "request", id: "<uuid>", method: "chat.send", params: { ... } }

// Response: gateway → client
{ type: "response", id: "<request-id>", ok: true, result: { ... } }
{ type: "response", id: "<request-id>", ok: false, error: { code, message } }

// Event: gateway → subscribed clients
{ type: "event", topic: "chat.assistant_message", data: { ... } }

// Subscribe / unsubscribe: client → gateway
{ type: "subscribe", id: "<uuid>", topics: ["chat.*/session-123"] }
```

### Methods (v1)

| Namespace    | Methods                                                                    |
|--------------|----------------------------------------------------------------------------|
| `session.*`  | `start`, `resume`, `end`, `list`, `search`                                 |
| `chat.*`     | `send` (user message), `stream` (server push), `history`                   |
| `approvals.*`| `list`, `decide`                                                           |
| `plugins.*`  | `list`, `enable`, `disable`, `reload`, `configure`                         |
| `channels.*` | `list`, `bind` (channel → session routing), `unbind`                       |
| `routines.*` | `list`, `create`, `update`, `delete`, `run_now`                            |
| `admin.*`    | `health`, `config`, `tokens.create`, `tokens.revoke`                       |

### Events (v1)

`chat.user_message`, `chat.assistant_message`, `chat.text_delta`, `chat.tool_call`, `chat.tool_result`, `approvals.pending`, `approvals.decided`, `plugins.changed`, `routines.fired`, `log.line`.

All schemas live in `@squad/protocol` as Zod — validated on both sides.

---

## Sessions & Storage

**SQLite**, single file. Tables:

- `sessions(id, title, platform, remote_id, model, created_at, updated_at, system_prompt_hash)`
- `messages(id, session_id, role, content_json, created_at)` with FTS5 index on extracted text
- `tool_calls(id, session_id, message_id, name, input_json, result_json, status, created_at)`
- `approvals(id, session_id, tool_call_id, decision, reason, decided_by, decided_at)`
- `routines(id, name, cron, prompt, model, delivery_json, enabled, last_run_at, next_run_at)`
- `plugins(id, version, enabled, config_json, installed_at)`
- `tokens(id, label, hash, scopes_json, created_at, revoked_at)`

The gateway holds an open handle; writes are serialized. Backups are "copy the file". This is fine for the scale this project targets (one user, one Discord, one dashboard, a handful of concurrent conversations).

**Memory is injected into the user message, not the system prompt** — this preserves Anthropic prompt caching of the system prefix across turns (pattern borrowed from hermes-agent).

---

## Plugins — Authoring & Loading

A plugin is an npm package (or a local directory) with this shape:

```
my-plugin/
├── package.json
│   └── "squad": { "entry": "./dist/index.js" }
├── src/
│   └── index.ts   → default export: definePlugin({...})
└── README.md
```

On startup the gateway:

1. Reads `extensions/` and any paths in `config.yaml`'s `plugins` list.
2. For each, dynamically `import()`s the entry, gets the default export, validates it.
3. Calls `plugin.register(api)` with a scoped `GatewayAPI`:
   - `api.tools.register(tool)`
   - `api.providers.register(name, client)`
   - `api.channels.register(adapter)`
   - `api.skills.register(skill)`
   - `api.routines.register(routine)`
   - `api.hooks.on(event, handler)` — subscribe to runner hooks
   - `api.logger` / `api.config` / `api.storage` — scoped helpers
4. Stores the returned cleanup function (if any) for `plugins.disable` / `plugins.reload`.

Plugins are **not sandboxed**. The assumption is you're self-hosting and you trust what you install — same model as OpenClaw. Sandboxing can come later if there's ever a marketplace.

---

## Agent Loop — What We Vendor

The loop itself is unchanged from agentic. The gateway's job is to:

1. Build an `AgentSpec` from the session state:
   - `messages` — loaded from SQLite
   - `tools` — registry filtered by policy (approval-gated tools declared via tags)
   - `systemPrompt` — base prompt + plugin-contributed skills (cached)
   - `onTextChunk` — broadcast each delta as a `chat.text_delta` event
   - Hooks: `before_tool_call` (approval check), `after_tool_call` (persist + broadcast), `after_agent_end` (persist final message, mark session idle).
2. `await runAgent(spec)` on a worker (one per session). Runs are concurrent across sessions.
3. Persist messages/tool calls as they happen.

Approval flow:

- A tool tagged `write`/`exec`/`network` (when policy requires) hits `before_tool_call`.
- The hook inserts a row in `approvals`, broadcasts `approvals.pending`, and awaits a decision (with a timeout).
- The dashboard / Discord reaction triggers `approvals.decide`.
- On approve, the hook returns; the runner executes the tool. On deny, the hook returns an error `ToolResult` that the model sees.

---

## Routines (scheduled agents)

Cron-scheduled runs, modeled on hermes' `cron/`:

- A routine is `{ cron, prompt, model, delivery }` stored in SQLite.
- A 60-second tick inside the gateway looks for due routines.
- Each due routine spawns an agent run in a fresh session (or a named persistent one).
- `delivery` decides where output goes: a Discord channel, a dashboard inbox, or `[SILENT]` (stored only).

Routines are a v1 feature because "run this every morning" is one of the highest-leverage things an agent platform can do, and it's cheap once the rest of the pieces exist.

---

## Configuration

`config.yaml`:

```yaml
server:
  host: 0.0.0.0
  port: 8080
  data_dir: ./data            # SQLite + logs live here

auth:
  # one or more API keys with scopes
  tokens:
    - label: dashboard
      key_env: SQUAD_DASHBOARD_TOKEN
      scopes: ["*"]
    - label: discord-connector
      key_env: SQUAD_DISCORD_TOKEN
      scopes: ["channel:discord", "chat.*", "session.*"]

llm:
  # Model used when a session / routine doesn't specify its own.
  # Accepts either a bare model id (provider inferred from the name)
  # or an explicit "provider/model-id" string.
  default_model: claude-sonnet-4-6

  # Per-provider API keys. Omitted providers fall back to <PROVIDER>_API_KEY
  # environment variables. Local providers (ollama, lmstudio, llamacpp, vllm)
  # don't need a key.
  providers:
    anthropic:
      api_key_env: ANTHROPIC_API_KEY
    openai:
      api_key_env: OPENAI_API_KEY
    openrouter:
      api_key_env: OPENROUTER_API_KEY
    google:
      api_key_env: GOOGLE_API_KEY
    groq:
      api_key_env: GROQ_API_KEY
    # ... deepseek, mistral, together, xai, perplexity, fireworks, cerebras,
    #     cohere, sambanova, novita, hyperbolic, lambda, z-ai, minimax, kimi,
    #     opencode-zen, opencode-go — same shape, all optional.
    ollama:
      base_url: http://localhost:11434
    lmstudio:
      base_url: http://localhost:1234/v1
    # Escape hatch for any OpenAI-compatible endpoint not listed above.
    openai-compatible:
      base_url: https://my-custom-endpoint.example.com/v1
      api_key_env: MY_CUSTOM_KEY

plugins:
  - ./extensions/my-cool-tool
  - "@squad-community/slack-channel"   # npm package

policy:
  approvals:
    # tools with these tags require approval unless the session is marked trusted
    require_for_tags: ["write", "exec", "network"]
    timeout_seconds: 120
```

---

## Deployment

**Docker Compose** is the only deployment target we commit to for v1.

```yaml
services:
  gateway:
    image: squad/gateway
    ports: ["8080:8080"]
    volumes: [./data:/app/data, ./config.yaml:/app/config.yaml:ro]
    environment: [ANTHROPIC_API_KEY, SQUAD_DASHBOARD_TOKEN]

  discord:
    image: squad/connector-discord
    depends_on: { gateway: { condition: service_healthy } }
    environment:
      - SQUAD_GATEWAY_URL=ws://gateway:8080
      - SQUAD_DISCORD_TOKEN
      - DISCORD_BOT_TOKEN
```

The dashboard is served by the gateway at `/` — no separate service.

Bare-metal is fine too (`pnpm start`), but we don't ship installers or systemd units in v1.

---

## What v1 is NOT

Deliberately cut so the first release can actually ship:

- **Not multi-user.** One person, one deployment, one dashboard. Multi-tenancy is post-v1.
- **Not Kubernetes.** Helm charts can come later if anyone asks.
- **Not an agent router.** We ship many providers but the agent loop is one-model-per-run. Cross-model orchestration (A asks B for help, ensemble voting, etc.) is post-v1.
- **Only one shipped channel (Discord).** The channel contract is designed for any communication medium, but the only first-party channel in v1 is Discord. Slack, Telegram, SMS, email, voice, etc. are planned as channel plugins after v1 ships.
- **Not a marketplace.** You install plugins by pointing at a path or an npm package. No registry, no ratings, no sandbox.
- **Not sandboxed execution.** Tools run in the gateway process. Dangerous tools are approval-gated, not sandboxed. (If you need a sandbox, a plugin can shell out to Docker.)
- **Not a hosted service.** No cloud, no SaaS, no telemetry.

---

## Discord Implementation Plan

Discord is the first channel we ship. This section is the concrete build plan for `packages/channel-discord`, separate from the channel abstraction in general so that "how Discord works" doesn't pollute the architecture doc.

### Goals

1. Prove the channel contract end-to-end: a message in Discord → gateway session → agent run → streamed reply back to Discord.
2. Handle the real-world messiness: long replies, attachments, reactions for approvals, DMs vs. channels, threads, typing indicators.
3. Stay in one file per concern so future channels have a clear template to copy.

### Package layout

```
packages/channel-discord/
├── package.json
├── src/
│   ├── index.ts              # entrypoint: parse env/config, instantiate, run
│   ├── bot.ts                # discord.js Client setup, intents, event wiring
│   ├── inbound.ts            # Discord message → protocol chat.send
│   ├── outbound.ts           # protocol events → Discord messages / edits
│   ├── approvals.ts          # reaction-based approve/deny flow
│   ├── session-map.ts        # (guild, channel, user) ↔ session_id
│   ├── formatting.ts         # markdown, code blocks, 2000-char chunking
│   ├── attachments.ts        # upload/download via Discord CDN + gateway blob API
│   └── config.ts             # Zod-validated channel config
└── test/
```

### Configuration

```yaml
# in config.yaml, or a channel-specific file
channel:
  discord:
    bot_token_env: DISCORD_BOT_TOKEN
    gateway_url: ws://gateway:8080
    gateway_token_env: SQUAD_DISCORD_TOKEN
    # Where the bot listens. If empty, responds anywhere it's @mentioned.
    bindings:
      - guild_id: "..."
        channel_id: "..."
        agent: default       # which agent/session config to use
      - dm: true             # also respond in DMs
    # Which tool tags trigger a reaction-based approval prompt.
    approval_tags: ["write", "exec", "network"]
    # Format preferences
    max_message_length: 1900  # safe margin under Discord's 2000
    stream_edits: true        # edit the same message as tokens stream in
```

### Behaviors

**Inbound.**
- `discord.js` `Client` with `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages` intents.
- On `messageCreate`: filter by binding (mention, DM, or configured channel). Resolve `(guild_id, channel_id, user_id) → session_id` via `session-map.ts`, creating via `session.start` if new. Forward content + attachment URLs with `chat.send`.
- Typing indicator starts on receipt, stops on `chat.assistant_message`.

**Outbound.**
- Subscribe to `chat.text_delta`, `chat.assistant_message`, `chat.tool_call`, `chat.tool_result` scoped to this channel's sessions.
- If `stream_edits` is on: first delta creates a new Discord message; subsequent deltas edit it until the final `chat.assistant_message` arrives. Re-chunk at the 1900-char boundary by creating a new message.
- Tool activity renders as a compact italic line (`🔧 running read_file(...)`) — configurable.

**Approvals.**
- On `approvals.pending` event where the tool's tags intersect `approval_tags`: post an embed describing the tool call + inputs, with ✅ / ❌ reactions.
- Only the binding's owner (or a configured allowlist) can react. First valid reaction wins; call `approvals.decide` with the verdict.
- Timeout mirrors the gateway policy; the bot posts the denial reason if it fires.

**Attachments.**
- Inbound: Discord attachments are downloaded and re-uploaded to a gateway blob endpoint (or passed by URL if they're public and the agent supports fetch). Agent sees them as content blocks.
- Outbound: assistant messages containing `image` content blocks are uploaded as Discord attachments (`AttachmentBuilder` from buffer).

**Resilience.**
- Reconnect to the gateway with exponential backoff (`@squad/channel-sdk` handles this).
- `discord.js` handles Discord gateway reconnects.
- The `session-map` file is the source of truth across restarts — don't lose conversations just because the bot bounced.

### Phasing

The Discord channel ships in three increments so we can cut a release at each:

| Phase | Scope                                                                 | Release gate                          |
|-------|-----------------------------------------------------------------------|---------------------------------------|
| D0    | Inbound text → agent → outbound text. No streaming, no attachments.   | Chat roundtrip works in one channel.  |
| D1    | Streaming edits, typing indicators, 2000-char chunking, DMs, threads. | Usable for real conversations.        |
| D2    | Reaction approvals, attachments (in + out), binding config UI.        | Feature-complete for v1.              |

### Definition of done for v1

- [ ] D0 / D1 / D2 all merged.
- [ ] End-to-end integration test (real bot token, test guild) runs in CI on main.
- [ ] Docker image published (`squad/channel-discord`).
- [ ] Docs: "Set up a Discord bot in 10 minutes" walkthrough.
- [ ] Failure modes audited: gateway down, Discord down, token revoked, rate-limited. Each has a defined behavior.

---

## Roadmap

**v1 — the stable core**

- [ ] `@squad/protocol` — wire types + Zod
- [ ] `@squad/gateway` — WS server, dispatch, sessions, SQLite, plugin host
- [ ] `@squad/runner` — vendor agent-loop.ts + deps
- [ ] `@squad/llm` — vendor types, client factory, and all three provider implementations (anthropic, openai, openai-compatible) covering the full agentic provider list
- [ ] `@squad/tools` — base tool + registry + minimal built-ins
- [ ] `@squad/plugin-sdk` — definePlugin contract
- [ ] `@squad/channel-sdk` — shared runtime for channel processes
- [ ] `@squad/channel-discord` — first-party Discord channel (D0 → D1 → D2, see plan above)
- [ ] `@squad/dashboard` — chat, sessions, approvals, plugins, channels, routines
- [ ] Routines (cron)
- [ ] Docker Compose for the full stack
- [ ] One example plugin of each kind

**v1.1 — ergonomics**

- [ ] FTS5 session search UI
- [ ] Memory / skills system (MEMORY.md pattern, injected into user message)
- [ ] Hot-reload for plugins
- [ ] Better error envelopes and plugin-error isolation

**Post-v1 — "if people actually use it"**

- [ ] Second channel (Slack, Telegram, SMS, email — whichever has real demand)
- [ ] Voice channel (realtime audio in + TTS out)
- [ ] IDE channel (ACP bridge or VS Code extension)
- [ ] New providers that don't fit the native-Anthropic / native-OpenAI / OpenAI-compatible trio, as first-party plugins
- [ ] Multi-user / teams
- [ ] Kubernetes Helm chart
- [ ] Plugin marketplace (requires a sandbox story first)

