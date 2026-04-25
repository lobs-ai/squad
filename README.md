# Squad

**A self-hostable agent platform built for usability and subagents.**

Chat-based agents are usable the way a command line is usable: if you know the incantation, great. Squad raises the floor. The agent can hand you a **multiple-choice question** with buttons when it needs a decision. It can show you a **live task list** of what it's planning and what it's done. It can **spawn subagents** that work in parallel, claim tasks, and report back — and you see the whole tree in whatever client you're in.

Five things make Squad different:

1. **Subagents are first-class.** A parent agent can spawn workers with their own model, tools, system prompt, and budget; they run in parallel, stream progress back, and every run is its own searchable session. Ship a `code-reviewer` or `researcher` as a plugin, any agent can call it.
2. **Tasks are a shared primitive, not a markdown hack.** Agents — parent and subagents — create tasks, claim them, express dependencies, and mark them complete. Users see the same list. The task list is how multi-agent work stops being chaos.
3. **Ask-user questions are native per channel.** The agent asks a structured question with 2–4 options; Discord renders it as buttons with an "Other…" modal, the dashboard as a side-by-side card, the CLI as a select prompt. One tool call, channel-native UX.
4. **The protocol is the product.** Every client — Discord, dashboard, CLI, your own UI — speaks the same WebSocket wire. Tasks, questions, and subagent trees are protocol primitives, so every client gets consistent rendering for free. No client is privileged.
5. **Vendored, not imported.** The agent loop and LLM clients live in `packages/runner` / `packages/llm`, copied from [`lobs/agentic`](https://github.com/lobs-ai/agentic) with pinned source commits. You pick when to re-sync.

## Quick start

```bash
git clone https://github.com/lobs-ai/squad.git
cd squad
pnpm install
pnpm start            # interactive wizard on first run, then `squad mgr start --all`
```

One container per squad. State lives under `~/.squad/squads/<name>/` (config, secrets, sqlite, uploads, ssh). Open the dashboard at http://localhost:8080 (token in `~/.squad/squads/<name>/.env`) and mention the bot in the Discord channel you configured.

Manage multiple squads with `squad mgr` — see `squad mgr help`.

## How it works

```
 Discord  ─┐                   ┌──▶  Runner (agent loop)  ──▶  LLM + Tools
Dashboard ─┼──WS──▶  Gateway  ─┤                          ──▶  Subagent pool (parallel workers)
 Your CLI ─┘                   ├──▶  Task store (session-tree-scoped, shared)
                               ├──▶  Question store (pending asks, channel-rendered)
                               └──▶  SQLite (FTS5)
```

- **Gateway** — one long-running process. Owns the wire protocol, sessions, storage, plugins, the agent loop, the subagent pool, the task store, and the question store. Channel-agnostic.
- **Channels** — anything that speaks the channel contract. Discord ships in-process by default; run it as a separate container for isolation if you want. Each channel declares its rendering capabilities and gets native tasks + questions for free.
- **Subagents** — `spawn_subagent({id, task, model, tools, budget})`. Each subagent gets its own session, its own live WebSocket topic, and inherits the parent's task list.
- **Tasks** — `create_task` / `update_task` / `list_tasks`. Scoped to a session tree so parents and subagents coordinate through one list.
- **Ask-user** — `ask_user({questions: [{question, options, preview?}]})`. One tool call, channel-native rendering.
- **Dashboard** — React + Vite served at `/`. Just another protocol client.
- **Plugins** — tools, providers, channels, skills, routines, and subagent definitions all register through one `definePlugin({...})` contract.

See [SPEC.md](SPEC.md) for the full design.

## What's in v1

- **Subagent primitive** — parallel workers, per-subagent model/tools/budget, tree view in dashboard, FTS5 across every run
- **Task primitive** — shared task list per session tree, dependencies, live updates to every client
- **Ask-user primitive** — structured multiple-choice questions with per-channel native rendering (Discord buttons, dashboard cards, CLI select)
- **Channel-agnostic gateway** with Discord as the first-party reference channel (in-process by default, out-of-process option documented)
- **Every LLM provider agentic supports** — native Anthropic, native OpenAI, and ~24 OpenAI-compatible endpoints (OpenRouter, Google, Groq, DeepSeek, Mistral, xAI, Perplexity, Fireworks, Cerebras, Cohere, SambaNova, Novita, Hyperbolic, Lambda, Ollama, LM Studio, llama.cpp, vLLM, z-ai, Minimax, Kimi, plus an `openai-compatible` escape hatch)
- **Minimal built-in tools** — read/write/list/fetch/search plus the subagent, task, and ask-user tools
- **SQLite sessions** with FTS5 search across parent and subagent transcripts
- **Approval queue** for tools tagged `write` / `exec` / `network`; pluggable policy engine for per-path / per-host rules
- **Cron routines**
- **Plugin API** for tools, providers, channels, skills, routines, subagents

Explicitly **not** in v1: other first-party channels (Slack, Telegram, email, voice), Kubernetes, multi-user, plugin sandboxing, a marketplace, a learning loop / agent-curated memory. See [SPEC.md](SPEC.md#what-v1-is-not) for why.

## Status

Early development. The current repo is the design; packages under `packages/` are being scaffolded.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
