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
 Discord  ─┐                    ┌──▶ Runner (agent loop) ──▶ LLM (27 providers) + Tools + MCP servers
  Slack   ─┤                    ├──▶ Subagent pool (parallel; Claude Code / Codex runtimes plug in)
Dashboard ─┼──WS──▶ Gateway  ───┼──▶ Task store · Question store · Approval engine (channel-rendered)
 Your CLI ─┤       + /v1 HTTP   ├──▶ Routines (cron + webhook) · trace.step observability
   …      ─┘                    ├──▶ SQLite (sessions / messages / tasks, FTS5)
                                └──▶ MemCore (typed memory, hybrid FTS + vector retrieval)
```

- **Gateway** — one long-running process. Owns the wire protocol, sessions, storage, plugins, the agent loop, the subagent pool, the task store, and the question store. Channel-agnostic.
- **Channels** — anything that speaks the channel contract. Discord and Slack ship as channel plugins, in-process by default; run a channel as a separate container for isolation if you want. Each channel declares its rendering capabilities and gets native tasks + questions for free.
- **Subagents** — `spawn_subagent({id, task, model, tools, budget})`. Each subagent gets its own session, its own live WebSocket topic, and inherits the parent's task list.
- **Tasks** — `create_task` / `update_task` / `list_tasks`. Scoped to a session tree so parents and subagents coordinate through one list.
- **Ask-user** — `ask_user({questions: [{question, options, preview?}]})`. One tool call, channel-native rendering.
- **Dashboard** — React + Vite served at `/`. Just another protocol client.
- **Plugins** — tools, providers, channels, skills, routines, and subagent definitions all register through one `definePlugin({...})` contract.

See [SPEC.md](SPEC.md) for the full design.

## What's shipped

- **Subagent primitive** — parallel workers, per-subagent model/tools/budget, tree view in dashboard, FTS5 across every run. External agent runtimes (Claude Code, Codex) plug in as subagent kinds over stdio.
- **Task primitive** — shared task list per session tree, dependencies, live updates to every client
- **Ask-user primitive** — structured multiple-choice questions with per-channel native rendering (Discord buttons, dashboard cards, CLI select)
- **Two first-party channels** — Discord (reference) and Slack, both as plugins on the channel SDK. In-process by default, out-of-process supported.
- **MCP, first-class** — MCP servers register as tools indistinguishable from native ones at the registry layer; the gateway can also expose itself as an MCP server.
- **Agent-curated memory** — MemCore, a separate typed memory engine (hybrid FTS + vector retrieval) feeding eager + per-turn-retrieval prompt blocks, with idle session ingestion.
- **Every LLM provider agentic supports** — native Anthropic, native OpenAI, and ~24 OpenAI-compatible endpoints (OpenRouter, Google, Groq, DeepSeek, Mistral, xAI, Perplexity, Fireworks, Cerebras, Cohere, SambaNova, Novita, Hyperbolic, Lambda, Ollama, LM Studio, llama.cpp, vLLM, z-ai, Minimax, Kimi, plus an `openai-compatible` escape hatch) — with per-provider credential pools (round-robin + 429 backoff).
- **Built-in tools, lazy-loaded via tool groups** — read/write/edit/ls, grep/glob/find/code_search, exec, web search/fetch, the three primitives, plus memory, cron, config, env, plugin-management, apps, doctor, restart, html-to-pdf and pptx.
- **SQLite sessions** with FTS5 search across parent and subagent transcripts; crash recovery re-fires in-flight turns at boot.
- **Approval engine** — tag-match plus a structured predicate-rule DSL, scoped global / session / subagent, with a live dashboard queue.
- **Routines** — cron- and webhook-triggered agent runs with prompt / script payloads and pluggable delivery.
- **HTTP API** — OpenAI-compatible `/v1` shim alongside the WebSocket protocol.
- **Observability** — structured `trace.step` events per agent-loop iteration.
- **Context-file auto-discovery** — walks up from `cwd` loading AGENTS.md / CLAUDE.md / SQUAD.md / .cursorrules.
- **Plugin system** — manifested (`squad.plugin.json`), hot-reloadable; registers tools, providers, channels, skills, routines, subagents, toolsets, slash commands, HTTP routes, prompt fragments, and dashboard UI contributions.

Not yet shipped: a sandboxed code-execution tool (`run_script` / RPC), a Docker-isolated exec backend, markdown export/import for memory, agent-authored skills, multi-user, plugin sandboxing, a marketplace, Kubernetes. See [SPEC.md](SPEC.md) for the long-form design.

## Status

Actively developed and running. ~70K lines across 18 workspace packages; `pnpm -r build` and `pnpm -r test` pass. The four primitives, both channels, MCP, memory, routines, the approval engine, and the dashboard are wired end-to-end. See [AGENTS.md](AGENTS.md) for the per-package snapshot and [docs/agent/](docs/agent/INDEX.md) for the agent-facing reference.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).
