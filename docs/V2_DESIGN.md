# Squad — Forward Design

> **Status (2026-06-23):** Most of the original v2 gap-analysis has shipped. The
> realized capabilities are now described in the live docs (`README.md`,
> `AGENTS.md`, `docs/agent/`). This file is trimmed to (a) a map of what landed
> and where, and (b) the items still genuinely open. The original long-form
> comparative analysis (vs. OpenClaw / Hermes) lives in git history.

## What shipped (and where it's documented)

| v2 proposal | Status | Lands in |
|---|---|---|
| MCP — first-class tools | ✅ shipped | `gateway/src/mcp/` (registry, client, server); `config.mcp.servers`. Reverse direction (squad-as-MCP-server) too. |
| External agent runtimes (Claude Code, Codex) as subagents | ✅ shipped | `gateway/src/subagents/runtime-stdio.ts`; see [primitives.md](agent/primitives.md) |
| Context-file auto-discovery | ✅ shipped | `gateway/src/context-discovery.ts`; [gateway-internals.md](agent/gateway-internals.md) hot-path step 8 |
| HTTP API (OpenAI-compatible) | ✅ shipped | `gateway/src/http-api.ts` — `/v1` |
| Memory: hybrid retrieval | ✅ shipped | MemCore (`packages/memcore/`) — FTS + vector; [storage-and-memory.md](agent/storage-and-memory.md) |
| Webhook routine triggers | ✅ shipped | `gateway/src/routines/` — `schedule.kind: "webhook"` |
| Completion-driven wake | ✅ shipped | `session.wake` event |
| Credential pools + rotation | ✅ shipped | `gateway/src/rotating-client.ts` |
| Plugin manifests + hot-reload | ✅ shipped | `squad.plugin.json`, `plugin-sdk/src/manifest.ts`, `plugins.reload` |
| Structured agent traces | ✅ shipped | `gateway/src/traces.ts` — `trace.step` |
| Structured approval rules (DSL) | ✅ shipped | `gateway/src/approvals/predicate.ts` + `rules.ts` |
| Skills as parameterized subagents | ◑ partial | skill kind → `skill:<id>` subagent; agent-authored skills not built |

## Still open

The proposals from the original analysis that have **not** shipped — the forward list.

### Code execution via RPC (`run_script`)
The agent writes JS/Python; the gateway runs it in a sandboxed worker; the
script imports a `squad` module exposing the tool registry — including
`ask_user`, `create_task`, `spawn_subagent`, not just leaf tools — as
functions. Only the final output enters context. The single best
context-compression lever we haven't built. Pairs with the sandbox below.
Approval policy: requires approval by default, with "approve this script
content hash" as a learnable rule.

### Docker-isolated exec backend
Today `exec` runs in-process against the host workspace (workspace isolation
per `data_dir`, not process isolation). A Docker exec adapter would give real
isolation and is the natural home for `run_script`.

### Markdown export/import for memory
MemCore is the single source of truth and has no on-disk mirror. A roundtrip
`~/.squad/memory/*.md` mirror would let users grep / edit / version / back up
memory as plain text, while the DB stays authoritative for the running gateway.

### Agent-authored skills
Skills exist as parameterized subagent definitions, but the agent doesn't yet
synthesize new ones from experience. Defer until the skills-as-subagents model
has soaked; when built, what gets created is a subagent definition file, not a
markdown blob.

## Things we still decline

The discipline is in saying no. These remain out of core — build as plugins if
genuinely needed:

| Feature | Decline because |
|---|---|
| Voice / TTS / STT | Scope explosion — plugin territory. |
| Image / video / music generation | Same — plugins, not core. |
| Browser automation (CDP) | Heavy dep, niche — plugin. |
| Computer use | Frontier-model-specific, fast-moving — plugin. |
| Shadow git checkpointing | Leaky layered over `exec`; prefer an intentional snapshot tool. |
| Dreaming / autonomous memory consolidation | High risk of corrupting long-term memory; revisit only with strong observability. |
| Multi-device pairing / multi-user | Single-deployment-per-user is a hard rule. |

## The Squad identity test

For each new feature: *does this make Squad more itself, or less?* Squad's
identity is **a self-hosted, gateway-centric platform where subagents, tasks,
and structured questions are first-class and every channel renders the same
primitives natively.** If a feature clutters the architecture diagram without
strengthening the existing primitives, the answer is "plugin, not core."
