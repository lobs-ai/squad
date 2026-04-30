# Squad parity design: closing gaps vs hermes-agent and openclaw

This design covers the capabilities present in `~/other/hermes-agent` and
`~/other/openclaw` that Squad does not yet have. It is organized so each
section is shippable on its own — you can take the cron polish in week
one and not look at the ACP adapter until Q3 if that's the call.

The design is opinionated about what stays out of scope. We are not
trying to out-channel openclaw or out-learn hermes; we are filling the
holes that block real users on Squad's existing primitives (subagents,
tasks, ask-user, the protocol).

The architectural rules in `AGENTS.md` are non-negotiable for every
section below: gateway is channel-agnostic, the protocol is the
contract, runner/llm stay vendored, plugins are the extension story.
When a section adds a new capability, it adds a new protocol namespace
or extends an existing one, not a privileged endpoint.

---

## 0. Priority and shape

| # | Capability                                | Effort | Ship order | Owner package(s)                                |
|---|-------------------------------------------|--------|------------|-------------------------------------------------|
| 1 | Cron delivery completion                  | 2-3 d  | now        | `gateway`, `tools/cron`, `channel-discord`      |
| 2 | Approval escalation wiring                | 2 d    | now        | `gateway`                                       |
| 3 | Routine execution → real agent turns      | 1-2 d  | now        | `gateway/routines`                              |
| 4 | FTS5 search over `session.search`         | 1 d    | now        | `gateway`, `dashboard`                          |
| 5 | TUI in `client-cli` (rich input + slash)  | 2 wks  | next       | `client-cli`                                    |
| 6 | Toolset distributions                     | 1 wk   | next       | `plugin-sdk`, `gateway`                         |

Items 1-4 close known gaps already listed in `AGENTS.md` "Status".
Items 5-6 are the real productization work.

---

## 1. Cron delivery completion

**Status.** `docs/CRON_DESIGN.md` already specifies the full job schema,
schedule semantics, run-log format, and adoption path. The gap called
out in `AGENTS.md`:

> Routine execution — routines register and fire, but firing only
> creates a session; it doesn't yet push the prompt through
> `runChatTurn` or honor the `delivery` field.

What we ship to close it:

- **Fire path goes through the agent loop.** When a `prompt` /
  `agentTurn` job fires, the gateway calls the same code path the
  Discord channel uses to submit a chat turn — `runChatTurn` against
  the resolved session, not a private "routine runner".
- **Delivery is a small fan-out.** A `Delivery` value (`silent` /
  `dashboard` / `discord` / future `webhook`) maps to a single
  registry of `DeliveryHandler`s in `packages/gateway/src/routines/`.
  Each handler receives `{ runId, sessionId, payloadKind, output,
  tokens }` and decides what to do. `silent` is a no-op. `dashboard`
  emits `routines.fired/<sessionId>` (already wired). `discord` calls
  the in-process discord channel's "post message to channel" surface
  by `channelId`.
- **`script` payload.** Spawned via `node:child_process.spawn` with
  `stdio: ["ignore","pipe","pipe"]`, captured into the run log,
  truncated to 16KB for the wire. `[SILENT]` first line and
  `{"wakeAgent": false}` exit-0 JSON are the wake gates as designed.
- **Run log surfacing.** `routines.runs` and `routines.tail` ship as
  designed; the dashboard's existing routine view gets a "recent
  runs" tab that renders the JSONL.

**Why now.** The cron DB and tick loop are already in. This is two to
three days of glue, and it makes the recently-shipped cron tools
actually useful.

**Don't do.** Distributed scheduling. Webhook delivery (sketch only).
Per-job locks; we already chose at-most-once.

---

## 2. Approval escalation wiring

**Status.** The policy engine and `approvals.*` dispatch exist; the
hook isn't yet called from `before_tool_call`.

**What ships.**

- `packages/gateway/src/runner/hooks.ts` — already vendored — gets a
  `beforeToolCall` implementation that calls `approvals.evaluate`
  with the tool name, args (size-capped), session, and tags from
  `BaseTool.tags`. Outcomes: `allow` | `deny` | `ask`.
- On `ask`, the runner is paused via the existing approval-pending
  primitive. The gateway publishes `approvals.requested/<sessionId>`
  with the tool call and its tags. Whatever channel owns the session
  renders its native approval UX (Discord reaction, dashboard modal,
  CLI confirm). On answer, `approvals.respond` resumes or aborts the
  call.
- Default policy: `tags: ["destructive"]` requires approval; everything
  else allowed. Configurable via `config.approvals.policy`.

**Why now.** This is the missing safety net for any non-trivial tool.
Without it, "give the agent shell" is gated only by trust.

---

## 3. Routine execution → real agent turns

This is rolled into §1 — the same fix. Calling out separately because
the AGENTS.md gap list does. Once §1 ships, this row can be deleted.

---

## 4. FTS5 search

**Status.** Index is populated; `session.search` is stubbed.

**What ships.**

- `session.search` accepts `{ query, limit?, sessionId? }` and runs
  the FTS5 query already prepared in migration 005. Result envelope:
  `{ hits: Array<{ sessionId, messageId, snippet, ts, score }> }`.
- Dashboard adds a `/search` view that calls the method on each
  keystroke (debounced 200ms) and shows hit + jump-to-message link.
  The protocol is the contract — CLI gets the same method and a
  `squad search "<query>"` subcommand for free.

**Why now.** It's a one-day finish on a feature already 90% built.

---

## 5. Rich TUI in `client-cli`

**Goal.** The reference terminal client should be usable as a daily
driver — not a proof-of-protocol toy. Match hermes' `ui-tui/`
ergonomics without dragging in their stack.

### 5.1 Keep the current shape

`packages/client-cli/src/ui/` already has `line-input.ts`, `slash.ts`,
`spinner.ts`, `statusbar.ts`, `tool-format.ts`. The TUI work is
*upgrades* to those files, not a rewrite, not Ink, not blessed.

### 5.2 Concrete additions

- **Multiline input.** `line-input.ts` learns `Alt+Enter` (or `\` at
  end of line) for soft-newlines; `Enter` submits. Backspace and
  arrows handle the wrapped buffer.
- **Slash autocomplete.** `slash.ts` already knows the registered
  commands; add a popup that filters as you type and accepts on
  `Tab`/`Enter`. List is sourced from `protocol.commands.list`
  (a new method, see §5.3) so plugin-contributed slash commands work
  the same way.
- **History.** Up/Down walks prior turns from `session-store.ts`.
  `Ctrl+R` opens a reverse-i-search like readline.
- **Approval modal.** When `approvals.requested` fires for the
  current session, the CLI inlines a `[a]llow / [d]eny / [w]hy?`
  prompt in-band. Same pattern as ask-user select.
- **Streaming indicators.** Tool calls render as collapsible blocks
  with start/stop timing. `tool-format.ts` already does the formatting;
  add the collapsible state.
- **Status bar second line.** Show the token usage counter (already
  in protocol) and the active subagent count.

### 5.3 New protocol method: `commands.list`

Channels and clients today hard-code their slash command lists. To
let the CLI surface plugin-contributed commands without each client
shipping a registry, add:

- `commands.list({ scope: "session" | "global" })` →
  `Array<{ name, description, args?: ParameterSchema }>`
- The gateway aggregates from the plugin host (each `definePlugin`
  with `commands?: SlashCommand[]`).

Discord and the dashboard adopt this method in the same PR — it's a
cleanup, not a CLI-specific carve-out.

### 5.4 Out of scope

- Mouse support, image rendering, sixel.
- Themes beyond the existing `skin.ts`.
- Anything that ships as a TUI binary separate from `client-cli`.

---

## 6. Toolset distributions

**Problem.** A subagent today picks tools by name from the gateway's
registered set. There is no way to ship a curated *bundle*
("research-toolset = web-search + web-fetch + pdf + browser") so
plugins stay tight and human-readable.

**Design.**

- Add a new plugin kind `toolset` to `packages/plugin-sdk`:

  ```ts
  type ToolsetPlugin = {
    kind: "toolset";
    name: string;          // e.g. "@squad/toolset-research"
    description: string;
    tools: string[];       // tool ids the toolset bundles
    requires?: string[];   // tool ids that must already be registered
  };
  ```

- The gateway exposes `toolsets.list` and `toolsets.resolve(name)` →
  the flat `string[]` of tool ids.
- `spawn_subagent` learns a `toolsets?: string[]` field, resolved at
  spawn time and unioned with the explicit `tools?: string[]`.
- Subagent definitions in `examples/subagents/` use the new field.

That's it — toolsets are not a new runtime concept, just a packaging
indirection. The registry stays flat. The only behavioral change is
"if a toolset references a tool that isn't registered, refuse to
spawn with a clear error".

**Why this is small.** No new storage. No new dispatch namespace
(`plugins.*` already covers listing). The runner is unchanged.


---

## What's *not* in this doc

- A redesign of the runner. The vendored loop is the loop; if we
  outgrow it, that's an `agentic` re-sync, not a Squad design.
- A new wire format. JSON-over-WS stays.
- A second storage engine. SQLite stays.
- Multi-tenant / multi-user. Deferred to v2; calls out where the
  current design forecloses or doesn't.
- Telemetry, hosted features, or any phone-home. Self-hosting first,
  always.

---

## Sequencing recommendation

**Sprint 1 (2 weeks, polish).** Items 1-4. Ends with cron useful end
to end, approvals enforced, search live. Closes the gaps already
listed in `AGENTS.md` "Status".

**Sprint 2 (3 weeks, productize).** Items 5-7. CLI becomes a daily
driver. Toolsets land. Slack ships, validating the channel contract
with a real second channel.

**Sprint 3 (4 weeks, expand).** Items 8-10 in parallel if staffing
allows; otherwise 8 → 9 → 10. After this Squad has skills, IDE
integration via ACP, and the batch runner — feature-comparable to
hermes in everything except training, with the subagent / task /
ask-user advantages preserved.

After Sprint 3 the v2 conversation can start: voice, multi-user,
sandboxed executors, marketplaces. None of those should land before
the Sprint-3 work is real.
