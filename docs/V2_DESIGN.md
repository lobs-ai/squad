# Squad v2 — Gap Analysis & Design

A comparative design doc benchmarking Squad against two mature agentic platforms (OpenClaw, Hermes) and proposing the next round of features. The bar isn't "ship what they ship" — it's to identify the genuine capability gaps, then build them in a way that fits Squad's architecture (gateway-centric, protocol-symmetric, subagents as primitive) and improves on what the others got wrong.

---

## 1. Where Squad Already Wins

Before enumerating gaps, name the things Squad does *better* than either reference. These are not negotiable in v2:

1. **Subagents as a true primitive.** OpenClaw and Hermes both have subagents, but they're treated as a fan-out helper. In Squad each subagent is a session — searchable, resumable, addressable from any client. Hermes throws away intermediate output. OpenClaw has the orchestrator pattern but limits depth to 2. Squad's depth-3 with a global pool and shared task list is the cleanest model of the three.
2. **Protocol symmetry.** Hermes has a TUI gateway *and* a web dashboard *and* ACP *and* an OpenAI-compatible HTTP server — four surfaces, four contracts, drift between them. OpenClaw is similar. Squad's "every client speaks the same WebSocket" is a real architectural advantage and we should not erode it.
3. **Structured ask-user.** Both references treat user clarification as free-text. Squad's typed multiple-choice with channel-native rendering (Discord buttons, dashboard cards, CLI selects) is genuinely better UX and trivially better for evals.
4. **Tasks, not chat history, as the coordination surface.** This is the right abstraction; nothing in v2 should weaken it.

---

## 2. Critical Gaps (ship in v2)

These are capabilities where Squad is meaningfully behind and the absence shows up in real usage.

### 2.1 MCP — first-class, not a bridge

**Status:** Squad has zero MCP support. OpenClaw uses `mcporter` as an external bridge. Hermes has it built in with per-server tool whitelisting/blacklisting and tool sampling.

**Why it matters:** MCP is now the universal connector for agentic tools. Every serious vendor (GitHub, Notion, Linear, Slack-as-tool, filesystem, Postgres, etc.) ships MCP servers. Without MCP, Squad's tool surface is whatever we ship plus what plugin authors write — a tiny fraction of what's available.

**Squad-specific approach (improving on the references):**
- Make MCP servers **plugin-equivalent at the registry level**. An MCP server registration produces tools in `ToolRegistry` that are indistinguishable from native tools at the agent loop layer. No second-class status, no separate dispatch path.
- Hermes' per-server allow/deny is good; add **runtime tool sampling** (advertise N of M tools to the model based on relevance to the current turn) for servers that expose 50+ tools. This is the lever that makes large MCP servers actually usable without context bloat.
- **Reverse direction too:** expose Squad's own gateway as an MCP server. Anyone running Claude Desktop / Cursor / etc. can connect and get squad's subagent + task primitives as tools. OpenClaw has `mcp serve` but only for ACP sessions; we can do better by exposing the full protocol.
- MCP servers go in `config.mcp.servers` with the same shape as `config.plugins`. Hot-reload via `gateway.reload()`.

**Don't copy:** Hermes' OAuth handshake for MCP servers is awkward (browser pop-up from CLI). Push that to the dashboard, where it belongs.

### 2.2 External agent runtimes (ACP) — but as subagents

**Status:** OpenClaw has ACP integration that runs Claude Code, Codex, Gemini CLI, Cursor, etc. as bound sessions. Hermes runs *inside* editors as an ACP server. Squad has neither.

**Why it matters:** A non-trivial fraction of users want squad to *delegate* to a stronger / cheaper / specialized agent (e.g., "use Claude Code to actually edit this large refactor"). Without ACP, squad has to reimplement everything internally.

**Squad-specific approach:**
- Don't ship ACP as a separate concept. Instead, **ACP runtimes are subagent kinds.** A plugin registers a subagent with `runtime: 'acp-codex'` or `runtime: 'acp-claude-code'`. The subagent pool spawns it the same way; the protocol surfaces it via `subagents.*` events; the dashboard renders it identically. The user doesn't have to learn a new concept.
- This is genuinely cleaner than OpenClaw's parallel ACP/subagent worlds. There, you have to understand both `sessions_spawn` and `acp spawn`, with subtly different binding semantics.
- Threading: instead of OpenClaw's "bind ACP to current chat thread," use Squad's existing channel routing. A channel can mark a thread as "owned by subagent X" and the channel-sdk handles the rest. Discord already supports this for native subagents; adding ACP is one config flag.
- **Don't run squad inside editors yet.** Hermes' ACP server mode adds a ton of surface area (different transcript format, different tool exposure, different cancellation semantics) for unclear value. Defer to v2.1.

### 2.5 Context file auto-discovery

**Status:** Squad doesn't auto-load `AGENTS.md` / `CLAUDE.md` / `.cursorrules`. Both references do.

**Why it matters:** This is the single highest ROI feature for users who already have a Claude Code or Cursor workflow. It's also nearly free to implement.

**Squad-specific approach:**
- On session start, walk up from `cwd` to find `AGENTS.md`, `CLAUDE.md`, `SQUAD.md`, `.cursorrules`. Inject in priority order, dedup'd.
- **Improvement over Hermes:** Hermes does *progressive* subdirectory discovery — when the agent `cd`s into a new subtree, that subtree's `AGENTS.md` gets injected. Steal this, but emit a structured event (`context.injected`) so the dashboard can show what's loaded and the user can disable specific files mid-session.
- Cap total context-file budget at ~8K tokens; when over, prefer the closest-to-cwd files.

### 2.6 HTTP API surface (OpenAI-compatible)

**Status:** Squad's gateway is WS-only for agent traffic. Hermes ships an OpenAI-compatible `/v1/chat/completions` HTTP shim. OpenClaw similar.

**Why it matters:** Lots of tooling speaks OpenAI HTTP — evals, scripts, curl one-liners, langchain, etc. Forcing them through WS is a needless papercut.

**Squad-specific approach:**
- Add `POST /v1/chat/completions` (and `/v1/messages` for Anthropic compat) that internally creates a session, runs a turn, and returns the assistant message. Streaming via SSE.
- This is **not a parallel agent loop** — it's a thin shim that dispatches into the existing protocol. Same gateway, same plugins, same approval queue. The HTTP request creates a phantom session that's auto-archived on completion.
- Tool use through HTTP API: optional. By default, HTTP requests use a constrained tool set (no `exec`, no `spawn_subagent`) because the caller has no way to answer ask-user questions or approve dangerous operations. Callers who want full power use WS.

---

## 3. High-Value Additions

These aren't critical, but each has a clear win.

### 3.1 Skills, but task-shaped

**Status:** Hermes has 100+ skills as markdown files; closed-loop skill creation. OpenClaw has skills as markdown bundles. Squad has a `skill` plugin kind but no built-in skill library.

**The OpenClaw/Hermes model is wrong.** A "skill" as "markdown file injected into the system prompt" is just prompt engineering with extra steps. The minute the skill needs different tools, a different model, or its own subroutines, the abstraction breaks.

**Squad's improvement:**
- A skill is a **named, parameterized subagent definition** — system prompt, tool subset, model, token budget, *plus* a structured input schema. Invoking a skill is `spawn_subagent({ subagent: 'skill:research', input: { topic, depth } })`.
- Skills can call skills. Skills appear in `subagents.list`. Skills are searchable.
- The "skill library" is just a plugin that registers a bunch of subagent definitions.
- Hermes' "agent autonomously creates skills from experience" is ambitious but unproven — defer to v2.1, and when we do it, what gets created is a subagent definition file, not a markdown file.

### 3.2 Memory: hybrid retrieval + markdown export

**Status:** Squad's memory is typed entries in SQLite with FTS5. Hermes uses MEMORY.md / USER.md plain-text. OpenClaw has plain-markdown plus pluggable backends (LanceDB, wiki).

**Improvements:**
- Add **vector retrieval** as a second index alongside FTS5. A small local embedding model (e.g., `all-MiniLM` via ONNX, no API cost, ~50MB) runs in the gateway process. Hybrid scoring: BM25 + cosine, weights configurable. This is a win for "find a memory that's semantically related but doesn't share keywords" cases that FTS5 can't do.
- Add **markdown export/import** so memories can be edited as plain text in the user's editor. The DB stays the source of truth for the running gateway, but `~/.squad/memory/*.md` is a real readable mirror that users can grep, version, and back up. Roundtrip on every write.
- Don't copy Hermes' "frozen snapshot at session start" pattern. Squad's eager-load + retrieval mix is already better.
- Don't copy OpenClaw's "dreaming" yet. It's clever but the failure modes (a bad consolidation pass corrupts the long-term store) are scary without much evidence of upside.

### 3.3 Code execution via RPC

**Status:** Hermes has `execute_code`: agent writes a Python script, the script calls hermes tools via Unix socket RPC, only the final output enters the LLM context. Multi-step workflows collapse into one turn.

**Why it matters:** This is genuinely the single best context-compression technique in any agent today. Instead of `for i in range(10): tool_call → result_in_context → tool_call`, the agent writes code that does the loop locally and returns one summary.

**Squad-specific approach:**
- Add `run_script` tool. The agent writes JavaScript or Python; the gateway runs it in a sandboxed worker (Node `vm` or a Docker python container per §2.4); the script imports a `squad` module that exposes the existing tool registry as functions.
- Improvement over Hermes: because Squad has the protocol, the script can also use **`ask_user`, `create_task`, `spawn_subagent`** — not just leaf tools. A script can fan out to subagents, await results, aggregate, and return one summary to the parent. This is a strict superset of what Hermes can do.
- Approval policy: `run_script` requires approval by default, with "approve this script content hash" as a learnable rule.

### 3.4 Webhooks → routine triggers

**Status:** Hermes has webhook subscriptions (external services trigger agent runs). Squad has cron routines but no HTTP-triggered routines.

**Improvement:** Extend the routines model so a routine's *schedule* can be a webhook URL instead of a cron expression. Posting to `/webhook/<routine-id>` fires the routine with the request body as payload. Auth via shared secret or HMAC. This is a 1-day implementation that opens up GitHub webhook → routine, Stripe webhook → routine, IFTTT → routine, etc.

### 3.5 Heartbeat / completion-driven wake

**Status:** OpenClaw has a heartbeat that periodically wakes the main session. Hermes is similar.

**Why:** When a long-running subagent finishes, the parent should resume immediately. Today, the parent is waiting on an awaitable; this works for `wait: true` spawns but not for `wait: false` "fire and check later" patterns.

**Squad-specific approach:**
- Don't add a heartbeat (polling is wasteful). Instead, when a subagent transitions to a terminal state, fire a `session.wake({ reason })` event to its parent. The parent's next message — whether from a user or the wake event — runs an agent turn with the new state visible.
- This is just plumbing, not new architecture, and it's a strict improvement over the heartbeat model.

### 3.6 Credential pools + provider routing

**Status:** Hermes lets you stack multiple API keys per provider and rotate on rate-limit/error. Squad has one key per provider.

**Improvement:** Config schema accepts `providers.<name>.keys: string[]` instead of `providers.<name>.key: string`. The LLM client rotates round-robin and excludes keys with active 429s for a backoff window. Deferred: per-key budget caps. This is small but high-value for anyone running squad heavily.

---

## 4. Things to Decline

It's easy to keep listing features. The discipline is in saying no.

| Feature | In refs | Decline because |
|---|---|---|
| Voice / TTS / STT | OpenClaw, Hermes | Scope explosion. The first plugin-author who needs it can build it. |
| Image / video / music generation | OpenClaw, Hermes | Same. Add as plugins, not core. |
| Browser automation (CDP) | OpenClaw, Hermes | Heavy dep, niche use, plugin territory. |
| Computer use | OpenClaw | Frontier-model-specific, fast-moving, plugin. |
| Shadow git checkpointing | Hermes | Tempting, but layered on top of `exec` it's leaky. Better: ship a snapshot tool that the agent calls intentionally before risky work. |
| Dreaming / autonomous memory consolidation | OpenClaw | High risk of corrupting long-term memory; defer until we have observability. |
| Multi-device pairing | OpenClaw | Single-deployment-per-user is a v1 hard rule; don't break it. |
| 20+ bundled channels | OpenClaw | Two well-tested channels > 20 mid-quality ones. |
| 47+ bundled providers | OpenClaw, Hermes | Squad already has 27 via the vendored llm package. Adding more is upstream work in `agentic`. |
| Agent-authored skills | Hermes | Unproven; defer to post-v2. |

---

## 5. Architectural Improvements (independent of any single feature)

### 5.1 Plugin host: hot-reload, isolation, manifest

Today, plugins are dynamically imported with `import()`. That works for trusted local plugins but doesn't scale.

- **Manifests:** require a `squad.plugin.json` next to the entry file declaring `id`, `version`, `requires` (other plugin ids + version ranges), `exposes` (kinds it registers), and `permissions` (which `GatewayAPI` namespaces it can touch). The plugin host enforces declared permissions.
- **Hot-reload:** structured. Cleanup hook returned from `register()` is required, not optional. On reload, old instance unregisters, new instance registers, in-flight tool calls drain.
- **Conformance tests:** ship a `@squad/plugin-test` package that any plugin can use to validate its manifest and registrations. CI for plugin authors.

This is the kind of thing that makes the difference between "we have a plugin system" and "people actually write plugins." OpenClaw nails this; we're behind.

### 5.2 Observability: structured agent traces

Squad logs via pino. That's fine for ops but useless for understanding *why* an agent did what it did.

- Every agent loop iteration emits a `trace.step` event with: prompt tokens, completion tokens, model, tool calls, time, cache hit ratio, parent step id.
- The dashboard renders this as a flame graph per session. Click a step, see the messages that produced it.
- This is a feature *neither reference has* (OpenClaw has logs, Hermes has token counters but no structured trace). Real differentiator.

### 5.3 Approval policy: structured rules, not just tags

Today, approval policy is `tag-match`. That's a good default but doesn't compose well.

- Add a small rule DSL: `tool == 'exec' && cmd.startsWith('git')` → auto-approve. `tool == 'write' && path.startsWith('/etc')` → deny. Hermes' "learnable approval patterns" is the right idea; just give it real syntax instead of pattern strings.
- Rules are scoped: global, per-session, per-subagent.
- The dashboard shows a live approval queue with a "remember this" toggle that synthesizes a rule.

---

## 6. Suggested Roadmap

Rough sequencing — each block is ~2 weeks. Adjust to taste.

**v2.0 (10 weeks):**
1. MCP support (§2.1) — *the single biggest gap*
2. Context file auto-discovery (§2.5) — *cheap, high-impact*
3. HTTP API shim (§2.6) — *unblocks tooling integration*
4. Sandboxed execution backend (§2.4) — *Docker exec adapter only*
5. Code execution via RPC (§3.3) — *because it pairs naturally with the docker sandbox*

**v2.1 (8 weeks):**
6. ACP runtimes as subagents (§2.2)
7. Slack channel + channel conformance tests (§2.3)
8. Memory: vector retrieval + markdown export (§3.2)
9. Webhook routine triggers (§3.4) + completion-driven wake (§3.5)

**v2.2 (6 weeks):**
10. Plugin manifests + hot-reload (§5.1)
11. Structured agent traces (§5.2)
12. Skills as parameterized subagents (§3.1) — built on top of the now-mature subagent primitive
13. Credential pools (§3.6) + structured approval rules (§5.3)

**Post-v2:**
- Webhook channel
- Telegram channel (community contribution territory)
- Memory consolidation (only after we have traces + observability)
- Agent-authored skills (only after the skills-as-subagents model has soaked)

---

## 7. The Squad Identity Test

For each new feature, ask: *does this make Squad more itself, or less?*

Squad's identity is **a self-hosted, gateway-centric platform where subagents, tasks, and structured questions are first-class and every channel renders the same primitives natively.**

- MCP: ✓ extends our tool surface without breaking the model
- ACP-as-subagent: ✓ literally folds external agents into our existing primitive
- HTTP API: ✓ another client of the same protocol
- Voice / image gen / browser: ✗ not primitives, just tools — push to plugins
- Multi-device / multi-user: ✗ explicitly violates the v1 rule that survives unchanged

The test is binary. If a feature makes the architecture diagram more cluttered without strengthening the existing primitives, the answer is "plugin, not core."
