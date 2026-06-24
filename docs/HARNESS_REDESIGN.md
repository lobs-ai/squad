# Squad — Harness Redesign

> **Status:** Design (2026-06-23). Decisions locked: providers, subagents, sequencing,
> session model, auth (see §0.3). This doc is the plan of record for moving Squad's
> **main agent loop** out of the vendored in-process runner and onto an external
> harness (Claude Agent SDK / Codex SDK). It supersedes nothing yet — `packages/runner`
> stays live until both adapters pass conformance (§9).

---

## 0. Scope

### 0.1 The one change

Squad already ships ~90% of what a "modular core" needs: the gateway, the `/ws` + `/v1`
surfaces, plugins, prompt fragments, skills, MCP (both directions), channels with
agent-driven sends. The redesign is **one structural move**:

> Promote the external harness from a *subagent runtime* (`subagents/runtime-stdio.ts`)
> and an *LLM provider* (`providers/claude-cli.ts`) to **the primary agent engine for
> the main session**, and retire the vendored in-process loop (`packages/runner`,
> most of `packages/llm`, most leaf tools in `packages/tools`).

Everything else in this doc is the blast radius of that move.

### 0.2 Continuity vs. redesign

| Subsystem | Fate |
|---|---|
| Gateway, `/ws` protocol, `/v1` shim, dashboard, iOS, CLI | **Unchanged** — clients never notice |
| Channels + explicit-send + `reply` (rule #7) | **Unchanged** — `reply` becomes an MCP tool, same contract |
| Tasks / questions / subagent primitives | **Unchanged contract** — transport flips to MCP tool calls |
| Plugins, prompt fragments, `PROMPT_SLOTS`, `RenderContext` | **Mostly unchanged** — apply to squad MCP tools, evaluated per resume |
| Approval engine (`approvals/predicate.ts` + `rules.ts`) | **Unchanged** — now fed by the harness's `canUseTool` callback |
| MemCore + memory injection | **Adapted** — eager block via `appendSystemPrompt`, retrieval via MCP tools |
| SQLite stores (sessions/messages/tool_calls) | **Adapted** — populated by ingesting the harness event stream |
| `packages/runner` (agent loop) | **Retired** for the main agent |
| `packages/llm` (27 providers, rotation) | **Demoted** to MemCore LLM router + `/v1` shim only |
| Leaf tools in `packages/tools` (read/write/edit/exec/grep/web) | **Retired** for the main agent — the harness's native tools replace them |
| Tool groups / lazy unlock (`groups.ts`) | **Retired** for the main agent — the harness owns its own context window |

### 0.3 Architecture rules being retired / replaced

From `docs/agent/architecture.md`:

- **Rule #9 "One process, one agent loop. No runtime-as-separate-service."** → **Retired.**
  The main loop now runs in an external harness process (Claude/Codex), managed by the
  Harness Manager. The gateway is still the center (rule #1 holds); it just no longer
  *contains* the loop.
- **Rule #5 "Runner and LLM are vendored."** → **Replaced** with "The harness is external
  and abstracted behind `HarnessSession`. `@squad/llm` survives only for non-harness LLM
  calls (MemCore router, `/v1` shim)."

All other rules (#1–4, #6–8, #10) stand. Notably **#7 "channels render intent, agents
emit intent"** and **#6 "subagents/tasks/questions are primitives"** are *strengthened*:
they become the squad MCP control plane, the agent's only door into Squad.

### 0.4 Locked decisions

1. **Providers — collapse to harness-native.** Claude covers Anthropic/Bedrock/Vertex;
   Codex's custom OpenAI-format endpoints (`base_url` + key) cover Groq/DeepSeek/OpenRouter/
   local-vLLM/etc. Between them they reach ~everything `@squad/llm` did. `@squad/llm` is kept
   only for the MemCore LLM router and the `/v1` shim. (Gap: per-key rotation — see §7.3.)
2. **Subagents — hybrid.** Squad pool for persistent/named/cross-session workers; harness-native
   for ephemeral in-turn fan-out. Unified id space + tree-merge (§6).
3. **Sequencing — both in lockstep**, made tractable by a resume-per-turn substrate both SDKs
   expose identically (§2.2).
4. **Session model — resume-per-turn is canonical; keep-warm pool is an optional cache** (§2.3).
5. **Auth — dual mode per session** (subscription OAuth token **or** API key), env-isolated per
   squad (§7).

---

## 1. Architecture

```
                         ┌─────────────────────────── Gateway (the center) ───────────────────────────┐
  Discord ─┐             │                                                                             │
   Slack  ─┤             │   dispatch · runs.ts (orchestrator) · stores · broadcast bus · plugins      │
 Dashboard ┼──WS/HTTP──▶ │            │                                              ▲                  │
  iOS / CLI┤             │            │ HarnessTurnRequest                           │ HarnessEvent     │
   …      ─┘             │            ▼                                              │ stream           │
                         │   ┌─────────────────── Harness Manager ──────────────────────────────┐      │
                         │   │  keep-warm pool · resume-per-turn lifecycle · event normalize     │      │
                         │   │   ┌──────────────┐                    ┌──────────────┐            │      │
                         │   │   │ ClaudeHarness│                    │ CodexHarness │            │      │
                         │   │   │ @anthropic-ai│                    │ @openai/     │            │      │
                         │   │   │ /claude-     │                    │  codex-sdk   │            │      │
                         │   │   │  agent-sdk   │                    │              │            │      │
                         │   │   └──────┬───────┘                    └──────┬───────┘            │      │
                         │   └──────────┼───────────────────────────────────┼────────────────────      │
                         │              │ canUseTool → approval engine        │ approval policy         │
                         │              ▼                                     ▼                          │
                         │   ┌────────── Squad MCP control plane ─────────────────────────────┐         │
                         │   │ ask_user · create_task · spawn_subagent · reply · memory · …    │         │
                         │   │  (Claude: in-process SDK MCP · Codex: served MCP endpoint)       │        │
                         │   └─────────────────────────────────────────────────────────────────┘        │
                         └─────────────────────────────────────────────────────────────────────────────┘
                                            ▲ native leaf tools (Read/Edit/Bash/Grep/Web)
                                            │ owned by the harness, governed by approval via canUseTool
```

Two data paths between the harness and Squad:

- **Agent → Squad (control plane):** MCP tool calls only. Squad primitives are MCP tools.
- **Squad ← Harness (data plane):** the normalized `HarnessEvent` stream — ingested into
  SQLite and rebroadcast on `/ws`. **The harness stream is the source of truth for a turn.**

---

## 2. The `HarnessSession` contract

New package: **`packages/harness`** (`@squad/harness`). Houses the contract, the two adapters,
the keep-warm pool, and the event-normalization layer. `packages/gateway/src/runs.ts` depends
on it instead of `@squad/runner`.

### 2.1 Interface

```ts
// packages/harness/src/types.ts

export type HarnessKind = "claude" | "codex";

export interface HarnessAuth {
  mode: "subscription" | "api-key";
  token: string;            // CLAUDE_CODE_OAUTH_TOKEN | OPENAI/ANTHROPIC_API_KEY | codex token
  baseUrl?: string;         // codex custom OpenAI-compatible endpoint, or ANTHROPIC_BASE_URL
  provider?: "anthropic" | "bedrock" | "vertex" | "openai" | "openai-compatible";
}

export interface HarnessCaps {
  inProcessMcp: boolean;       // claude: true · codex: false (served endpoint)
  perCallApproval: boolean;    // claude canUseTool: true · codex: policy-based (false)
  thinking: boolean;           // claude: true · codex: model-dependent
  resumeAcrossProcess: boolean;// both: true  ← the substrate that makes lockstep work
}

export interface HarnessStartSpec {
  sessionId: string;                  // squad session id
  resume?: string;                    // harness session/thread id; undefined = fresh
  model: string;
  auth: HarnessAuth;
  cwd: string;                        // the agent workspace (data_dir/workspace)
  appendSystemPrompt: string;         // SOUL/USER + eager memory + channel-reply + runtime-env
  squadTools: SquadToolset;           // squad primitive MCP tools to expose THIS turn
  allowedNativeTools: string[];       // harness-native leaf tools enabled this turn
  configDir: string;                  // isolated transcript/cred dir (per-squad)
}

export interface HarnessTurnInput {
  text: string;
  attachments?: HarnessAttachment[];
}

export interface HarnessSession {
  readonly kind: HarnessKind;
  readonly caps: HarnessCaps;
  /** Stream a single turn. Resolves the async iterable when the turn ends. */
  runTurn(input: HarnessTurnInput): AsyncIterable<HarnessEvent>;
  /** The harness's own session/thread id, available after `session.init`. Persist it. */
  harnessSessionId(): string | undefined;
  interrupt(): Promise<void>;
  /** Tear down (warm-pool eviction / gateway close). */
  close(): Promise<void>;
}

export interface HarnessFactory {
  /** Open or resume a session. Cheap for resume (process spawns on first runTurn). */
  open(spec: HarnessStartSpec, approval: ApprovalHook): Promise<HarnessSession>;
}
```

`ApprovalHook` is the bridge to the existing approval engine:

```ts
export type ApprovalHook = (call: {
  toolName: string;
  input: unknown;
  toolUseId: string;
  sessionId: string;
  surface: RenderSurface;   // dashboard | cli | channel | subagent | cron-isolated
}) => Promise<{ behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string }>;
```

### 2.2 Normalized event union

Both adapters translate their native streams into one union. This is the lockstep boundary.

```ts
export type HarnessEvent =
  | { t: "session.init"; harnessSessionId: string; model: string; tools: string[] }
  | { t: "turn.start" }
  | { t: "text.delta"; text: string }
  | { t: "thinking.delta"; text: string }                 // caps.thinking only
  | { t: "tool.start"; id: string; name: string; input: unknown; parentId?: string }
  | { t: "tool.end"; id: string; output: unknown; isError: boolean }
  | { t: "turn.end"; stopReason: string; usage: HarnessUsage }
  | { t: "notice"; kind: "api_retry" | "warning"; detail: unknown }
  | { t: "error"; category: string; message: string; retryable: boolean };

export interface HarnessUsage { inputTokens: number; outputTokens: number; costUsd?: number; }
```

Source mapping:

| `HarnessEvent` | Claude stream-json | Codex SDK |
|---|---|---|
| `session.init` | `system/init` (`session_id`, `model`, `tools`, `mcp_servers`) | first `thread`/`item` meta after `startThread`/`resumeThread` |
| `text.delta` | `stream_event` → `content_block_delta` (`text_delta`) | streamed text item deltas |
| `thinking.delta` | `stream_event` thinking deltas | model-dependent |
| `tool.start` / `tool.end` | `content_block_start`(tool_use) / tool_result | `item.started` / `item.completed` (command/tool items) |
| `turn.end` + usage | `result` (`tokens_in/out`, `total_cost_usd`) | `turn.completed` (usage telemetry) |
| `notice` (api_retry) | `system/api_retry` | n/a (surfaced as warning if present) |

### 2.3 Lifecycle: resume-per-turn + keep-warm pool

**Canonical path (resume-per-turn):**

1. `runs.ts` builds a `HarnessStartSpec` (resume = `session.harness_session_id`).
2. `HarnessManager.runTurn(sessionId, input)` → factory `open(spec)` → `session.runTurn(input)`.
3. Squad ingests the event stream; captures `harnessSessionId` from `session.init` and persists
   it on the session row.
4. On `turn.end`, the process exits (or returns to the warm pool). No idle processes by default.

**Why resume, not a held-open process** (the substrate for lockstep + restart-safety):

- Many long-lived, mostly-idle sessions → one held subprocess each is an fd/memory explosion.
- The gateway restarts (the `restart_gateway` tool, supervisor respawn). Live processes die on
  restart anyway, so resume-from-disk is required regardless — so make it the baseline.
- `resume(sessionId)` is the identical primitive on both SDKs; a held-process abstraction is
  Codex-shaped and awkward for Claude.

**Keep-warm pool (latency cache, optional):**

```ts
class WarmPool {
  // sessionId → { session, expiresAt }. TTL ~2–5 min; evict on memory pressure / gateway close.
  acquire(spec): HarnessSession   // reuse warm session if present & spec-compatible, else open(resume)
  release(sessionId): void        // start TTL; do not close immediately
}
```

A warm session skips the per-turn cold start — re-reading the transcript and **re-initializing
MCP servers**. That cold start is exactly the documented "claude-cli front-loads the entire tool
catalog (~10K tokens) every call" tax (`index.ts:504-528`); keep-warm pays it once per burst.
The warm process is **never** the source of truth — if it dies, the next turn resumes cold.

> **Caveat:** a warm/held process has a fixed system prompt for its lifetime — you cannot
> re-inject per-turn memory into it mid-session. Per-turn memory injection is therefore tied to
> resume (fresh process) or warm-process start. This is a second reason memory must also be a
> *pull* (MCP retrieval tool), not only a *push* (system-prompt block) — see §3.4.

---

## 3. Control plane (squad-as-MCP-server)

### 3.1 Native vs. squad tools — the split

The harness brings its **own** leaf tools (Claude: `Read`/`Edit`/`Bash`/`Glob`/`Grep`/`WebFetch`/
`WebSearch`; Codex: shell/apply_patch/etc.). The model is trained on these; reimplementing them as
squad MCP tools would be strictly worse. So:

- **Native leaf tools stay with the harness.** Squad enables/disables them via
  `allowedNativeTools` and governs each call via `canUseTool` → approval engine.
- **Squad exposes ONLY squad primitives via MCP:** `ask_user`, `create_task` / `update_task` /
  `list_tasks`, `spawn_subagent`, `reply` (channel send), memory (`memory_search` / `memory_write`),
  and squad meta tools (`squad_doctor`, `restart_gateway`, `cron`, config/env, app registry).

Consequence: `packages/tools` collapses to its squad-primitive surface; the read/write/exec/grep/
web tools are retired for the main agent (they remain available to non-harness paths if any).

### 3.2 Transport: in-process for Claude, served endpoint for Codex

This is the biggest adapter divergence and a real win on the Claude side:

- **Claude — in-process SDK MCP** (`createSdkMcpServer` + `tool()`). The squad primitives run as
  direct function calls inside the gateway process — **no subprocess, no stdio, no token catalog
  over the wire, type-safe**, and they close directly over the gateway's stores. This sidesteps
  both the ~10K-token catalog tax and the `list_changed` problem for squad tools.
- **Codex — served MCP endpoint.** Squad runs its existing `mcp/server.ts` (HTTP/streamable) and
  Codex connects via its MCP config (`base_url` + per-session token so squad knows the render
  context). Subprocess-class cost; mitigated by keep-warm.

`HarnessCaps.inProcessMcp` flags which path an adapter took, so `runs.ts` knows whether tool
descriptions can be tailored cheaply per turn.

### 3.3 Permission → approval engine

- **Claude:** `canUseTool(toolName, input, opts)` fires for **every** tool (native + MCP). The
  adapter routes it through `ApprovalHook` → `approvals/predicate.ts` + `rules.ts`, returns
  `{behavior: "allow"|"deny"}`. The approval engine, its rule DSL, and the dashboard queue survive
  intact — and now govern native file/exec too.
- **Codex:** approval is **policy-based** (config: on-request / on-failure / never), not a per-call
  callback. Squad sets the policy from the session's approval mode but cannot intercept each call as
  richly. **Documented leak** (§10) — verify whether the Codex SDK exposes a finer approval hook.

### 3.4 System prompt + memory

- Use **`appendSystemPrompt`** (append, not replace) so the harness keeps its native tool guidance.
  Inject: SOUL/USER core files, the **eager memory block**, the channel-reply section
  (`buildChannelReplySection`), and the runtime-env section — i.e. `buildSquadSystemPrompt` minus the
  tool-group index (gone) and minus context files (the harness auto-discovers `CLAUDE.md`/`AGENTS.md`
  from `cwd` itself).
- **Per-turn retrieval** memory moves to a `memory_search` MCP tool (pull), since a warm process
  can't take a fresh system-prompt block mid-session (§2.3 caveat). Eager = push at (re)start;
  retrieval = pull anytime.

### 3.5 Prompt fragments / `RenderContext` continuity

Fragments at `PROMPT_SLOTS.*` with `when(render, ctx)` predicates still work — for **squad MCP
tools**. Because squad builds the exposed toolset per turn (it knows the `RenderContext`: surface,
channel kind, capabilities), and because resume spins a fresh MCP init each turn, fragment-rendered
descriptions are evaluated fresh per turn exactly as today. They **cannot** decorate native leaf
tools. `PromptContextStore` version-bumping still drives squad-tool description refresh.

---

## 4. Data plane (ingestion & persistence)

### 4.1 Stream → stores → broadcast

`runs.ts` consumes the `HarnessEvent` iterable and drives the existing stores + broadcast bus:

| Event | Store / bus action |
|---|---|
| `session.init` | persist `harness_session_id`, `harness_kind` on the session row (`SessionStore`) |
| `text.delta` | broadcast `chat.text_delta/<sid>`; accumulate into the assistant message |
| `thinking.delta` | broadcast thinking topic (dashboard reasoning view) |
| `tool.start` / `tool.end` | `ToolCallStore` insert/update; broadcast tool topic |
| `turn.end` | finalize assistant `MessageStore` row; record usage/cost on the session |
| final assistant text | the "message the UI shows"; channels already sent via `reply` (explicit-send) |

The `RunPersister` incremental-flush concept (`run-persistence.ts`) adapts directly — it now flushes
on stream events instead of per-LLM-call.

### 4.2 Two transcripts, two jobs (important)

- **The harness's own JSONL** (`~/.claude/projects/...` / `~/.codex/sessions/...`) is the **resume
  substrate**. It **must not** be disabled (`--no-session-persistence` / `CLAUDE_CODE_SKIP_PROMPT_HISTORY`),
  or resume can't reconstruct and every turn would replay full history into a fresh session.
- **Squad's SQLite** is the **broadcast / search (FTS5) / UI / cross-client** store.

Point the harness's `configDir` (`CLAUDE_CONFIG_DIR` and the Codex equivalent) **inside the squad's
`data_dir`** so transcripts and creds are isolated per squad — satisfying the existing
"isolated provider creds, never share with ~/.claude" rule.

### 4.3 Crash recovery

Today the gateway "re-fires in-flight turns at boot." With resume-per-turn: if the gateway dies
mid-turn, the harness subprocess is orphaned/killed. On reboot squad finds the incomplete turn,
**re-resumes** the harness session, and either replays the user turn or reconciles against the
harness JSONL (which may hold a partial assistant turn). Reconciliation rule: trust the harness
transcript as canonical; squad re-ingests any tail it missed. Define this in the recovery module.

---

## 5. The two adapters

### 5.1 ClaudeHarness — `@anthropic-ai/claude-agent-sdk`

- `query({ prompt, options })`; resume via `options.resume = harnessSessionId` in a fresh process
  (canonical), or stream input for warm sessions.
- `canUseTool` → `ApprovalHook` (per-call approval; the rich path).
- Squad primitives via **`createSdkMcpServer` + `tool()`** (in-process).
- System prompt via `appendSystemPrompt`. Auth via env (`CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL`/Bedrock/Vertex as needed). **Do not use `--bare`** if
  on a subscription token (bare skips OAuth reads — §7.2).
- `caps = { inProcessMcp: true, perCallApproval: true, thinking: true, resumeAcrossProcess: true }`.

### 5.2 CodexHarness — `@openai/codex-sdk`

- `new Codex()` → `startThread()` / `resumeThread(id)` → `thread.runStreamed(prompt)` (async event
  generator). Threads persist in `~/.codex/sessions` (redirect into squad `data_dir`).
- Approval is **policy/config**-based, not per-call (§3.3 leak).
- MCP via Codex config; squad runs a **served** MCP endpoint (§3.2).
- Custom providers via `model_providers.<id>.base_url` + `env_key` — this is the multi-provider
  story (§7.1). System-prompt injection via Codex config/instructions (thinner docs — verify shape).
- `caps = { inProcessMcp: false, perCallApproval: false, thinking: model-dependent, resumeAcrossProcess: true }`.

### 5.3 Divergence table (manage via `caps`, not branches in `runs.ts`)

| Concern | Claude | Codex |
|---|---|---|
| Squad MCP transport | in-process SDK MCP | served HTTP MCP endpoint |
| Per-call approval | `canUseTool` callback | config policy |
| Multi-provider | Anthropic / Bedrock / Vertex / `ANTHROPIC_BASE_URL` | any OpenAI-format `base_url` |
| System prompt | `appendSystemPrompt` (documented) | config/instructions (verify) |
| Thinking stream | yes | model-dependent |
| Subscription auth | `CLAUDE_CODE_OAUTH_TOKEN` (not in `--bare`) | Codex login token |

`runs.ts` must stay harness-agnostic: it programs against `HarnessSession` + `HarnessCaps`, never
`if (kind === "claude")`.

---

## 6. Subagents (hybrid)

Decision: **Squad pool for persistent/named/cross-session workers; harness-native for ephemeral
in-turn fan-out.** Both must surface in one tree.

- **Squad-owned** (`SubagentPool`, `spawn_subagent` MCP tool): named definitions, per-subagent
  model/tools/budget, own session + `/ws` topic + FTS — unchanged. These are first-class and
  render in every client. Used for `code-reviewer`/`researcher`-style durable workers.
- **Harness-native** (Claude `Task`, Codex equivalent): ephemeral parallel fan-out inside a turn.
  Squad does **not** suppress them; it **observes** them from the event stream — `tool.start`/
  `tool.end` with `name = "Task"` and `parentId` linkage — and projects them into the tree as
  lightweight, read-only subagent nodes.

**Unified id space + tree-merge:**

- One `subagent_id` namespace. Squad-pool ids are minted by squad; harness-native ids are derived
  from the harness `toolUseId` (prefixed, e.g. `native:<toolUseId>`).
- The tree view merges two sources: pool rows (`SubagentDefStore` / pool state) + native nodes
  reconstructed from the stream. Native nodes are leaf-ish (no separate `/ws` control topic, no
  budget knobs) and marked `origin: "harness"`.
- **Open question:** do native subagents get their own searchable transcript? Claude nests their
  output in the parent JSONL; squad can extract it but it isn't a first-class session. Default:
  native subagent output is captured as tool I/O on the parent, not a separate session row. Promote
  to full sessions later if needed.

---

## 7. Providers & auth

### 7.1 Provider collapse

- Main agent uses harness-native model config. Claude → Anthropic/Bedrock/Vertex (+ `ANTHROPIC_BASE_URL`).
  Codex → OpenAI **and any OpenAI-format endpoint** via `model_providers.<id>.base_url` + key
  (Groq, DeepSeek, OpenRouter, Mistral, local vLLM/Ollama, …). This is why retiring `@squad/llm`
  for the main agent doesn't lose the multi-provider story.
- `@squad/llm` survives **only** for: the MemCore LLM router (embeddings/extraction/rerank) and the
  `/v1` OpenAI-compatible shim. Everything else in it is dead.

### 7.2 Auth — dual mode, env-isolated

- Per session, `HarnessAuth.mode` is `subscription` or `api-key`.
- **Subscription** (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; Codex login token): fine for
  Squad's identity — self-hosted, single-user (rule #10, multi-user declined). The operator runs
  their own Squad on their own subscription. **`providers/claude-cli.ts` already does this**, so the
  path is proven.
  - **Terms boundary:** subscription auth is bound to one account + subscription rate limits and may
    not be used to serve *other* users / resell. If Squad ever goes hosted multi-tenant, that path
    requires `api-key` (token billing) instead. The manager must support both; do not hard-code
    subscription. (Not legal advice — confirm against current Anthropic terms.)
  - **Gotcha:** Claude `--bare` mode skips OAuth/keychain reads and requires an API key. Don't pair
    bare with subscription.
- Tokens flow via env into the harness child, isolated per squad in `data_dir` (never `~/.claude`/`~/.codex`).

### 7.3 The rotation gap (decide)

`RotatingLLMClient` (round-robin across multiple keys + 429 backoff) is **not** a harness feature.
If multi-key pools matter, run a small rotating proxy and point the harness `base_url` at it
(`localhost:<proxy>`); the proxy owns rotation/backoff. Otherwise drop multi-key pools for the main
agent. **Open decision — does the user need this?** (Single-subscription self-host probably doesn't.)

---

## 8. What deletes (after both adapters pass — §9)

- `packages/runner` — the vendored agent loop (`agent-loop.ts`, `context-engine.ts`,
  `context-manager.ts`, `loop-detector.ts`, in-memory `session.ts`).
- `packages/tools` leaf tools — read/write/edit/ls/grep/glob/find/code_search/exec/web_*; keep the
  squad-primitive tools (re-homed onto the MCP server) + `ToolRegistry` if still used by non-harness
  paths.
- `packages/llm` — keep the MemCore router clients + `/v1` shim deps; delete the agent-facing provider
  surface, `RotatingLLMClient` (unless §7.3 keeps a slimmed version), the model chain, codex/claude-cli
  *provider* shims (superseded by the adapters).
- Update `docs/agent/architecture.md` (rules #5/#9), the README "How it works" diagram, `AGENTS.md`,
  `VENDOR.md`.

Nothing deletes until §9 Phase 3.

---

## 9. Migration (gateway stays running throughout; feature-flag per session)

- **Phase 0 — Scaffold.** New `packages/harness` with the contract, the `HarnessEvent` union, the
  warm pool, and a conformance harness (mirror `channel-sdk`'s `conformance.ts`). No behavior change.
- **Phase 1 — Claude adapter behind a flag.** `runs.ts` gains a branch: if
  `session.harness === "claude"`, build a `HarnessStartSpec` and drive `HarnessSession` instead of
  `runAgent`; else legacy path. Validate end-to-end on one session: streaming → SQLite + `/ws`,
  squad primitives via in-process MCP, `canUseTool` → approval engine, resume across a gateway restart,
  channel explicit-send via the `reply` MCP tool.
- **Phase 2 — Codex adapter + lockstep conformance.** Implement `CodexHarness`; both must pass the same
  conformance suite (turn lifecycle, resume, approval routing, subagent projection, usage accounting).
  Resolve the §3.3 / §5.2 Codex unknowns (approval hook, system-prompt injection) here.
- **Phase 3 — Flip default.** New sessions default to the harness; native leaf tools replace squad's;
  `@squad/llm` demoted (§7.1). Legacy `runAgent` path remains reachable only behind an explicit flag
  for one release.
- **Phase 4 — Delete (§8)** and update docs/rules. Audit the `close()` teardown ordering — the existing
  restart-hang suspect (`channels → mcpRegistry.stopAll() → http.close`) now also tears down warm-pool
  processes and in-process MCP servers; add harness teardown **before** `http.close`, with a timeout,
  to avoid a new hang vector.

---

## 10. Risks & open questions

1. **Lowest-common-denominator (lockstep).** Mitigation: capability flags (`HarnessCaps`) + adapter
   escape hatches, never LCD-only. The risk is real where Codex is thinner (approval, system prompt).
2. **Codex approval granularity.** Policy-based, not per-call → coarser than Squad's engine wants.
   *Open:* does the Codex SDK expose a per-call hook? Resolve in Phase 2.
3. **Codex system-prompt / MCP config shape.** Under-documented in the SDK README. *Open:* verify
   `instructions`/config injection + served-MCP attach. Resolve in Phase 2.
4. **Loss of tool-groups & custom compaction.** Accepted — the harness owns its context window. We
   trade Squad's context engine for the harness's. Watch for context-cost regressions on long sessions.
5. **Per-turn cold-start tax** (MCP re-init / catalog). Mitigated by the warm pool; in-process MCP
   removes it entirely for Claude.
6. **Subscription ToS** (§7.2) — fine for single-user self-host; blocks hosted multi-tenant.
7. **Two transcripts** (§4.2) — harness JSONL is load-bearing for resume; cannot be disabled. Disk
   duplication with SQLite is accepted.
8. **Rotation gap** (§7.3) — decide whether multi-key pools matter; proxy if so.
9. **Native subagent searchability** (§6) — default: captured as parent tool I/O, not first-class
   sessions. Revisit if the tree view needs deeper native nodes.

---

## 11. Naming for `bin/`

Per project convention, harness lifecycle stays under the existing `bin/squad` (`start`/`stop`/
`restart`/`status`); no new verbs. The warm pool and harness children live inside the gateway process
tree and are managed by `restart` (always rebuilds) like everything else.
