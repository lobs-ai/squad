# Primitives — subagents, tasks, ask-user

These three are first-class. Each has its own protocol namespace, its own
gateway store, and its own per-channel renderer contract. **Don't bolt new
features onto `chat.*` — extend the right namespace or add a new one.**

---

## Subagents

A subagent is a child agent loop with its own session, model, tools, system
prompt, and budget. Spawned via the `spawn_subagent` tool (in the lazy
`subagents` tool group — unlock it with `describe_tool_group`).

### Two flavours

- **Ad-hoc** — pass `prompt` directly. No registration needed. One-shot worker.
- **Named** — first call `create_subagent` to register a definition (gets its
  own `SOUL.md` and survives restarts), then spawn it by name. Use this when
  you find yourself spawning the same kind of worker repeatedly.

### Spawn input (high level)

```
spawn_subagent({
  subagent: "code-reviewer",   // omit for ad-hoc
  prompt: "Review the diff in packages/gateway",
  input: { focus: ["src/runs.ts"] },   // optional structured payload
  modelOverride: "claude-haiku-4-5",   // optional
  toolsets: ["@squad/toolset-research"], // optional, unioned with tools
  tools: ["read", "grep", "glob"],     // optional, narrowed allow-list
  wait: false,                          // true = inline result, false = sessionId
})
```

### What the gateway does

- `packages/gateway/src/subagents/pool.ts` — bounded concurrency (default 8
  global, 4 per parent), bounded depth (default 3), token & tool-call limits.
- Each spawn creates a child row in `sessions` with `parent_session_id` set.
  Full transcript, searchable (FTS5), resumable.
- Subagent runs broadcast on `subagents.*` topics — your `chat.*` stream stays
  clean. Dashboards subscribe to `subagents.*/<parent_session_id>` to render
  the tree.
- Cancellation propagates: cancel the parent → every in-flight descendant
  receives the signal and the spawn tool returns `status: "cancelled"`.
- Subagents inherit your task list and your approval policy. A definition can
  **narrow** the policy (drop tags, drop tools) but never widen it.
- `wait: true` blocks the spawn tool until the child finishes and returns the
  result inline. `wait: false` returns a `sessionId` immediately and the
  parent can poll, subscribe, or simply ignore until later.

### When to spawn

- Parallelisable work (research five sources at once, lint five packages).
- To protect your context from a long sub-task you don't need to keep in head.
- When you can describe the job in one prompt and don't need turn-by-turn
  steering. If you'd be ping-ponging with the worker, do the work yourself.

### Source

- Pool & runtime: `packages/gateway/src/subagents/pool.ts`,
  `runtime.ts`, `runtime-stdio.ts`, `registry.ts`, `backend.ts`
- Tool surface: `packages/tools/src/subagents/`
- Protocol: `packages/protocol/src/namespaces/subagents.ts`

---

## Tasks

A shared, session-tree-scoped task list. Parent and every subagent in the
tree see the same list. Users see it too — natively rendered per channel.

### Tools

- `create_task` — add a task. Returns the id. New tasks are `pending`, no owner.
- `update_task` — single tool with multiple uses: claim (`owner: self`),
  start (`status: "in_progress"`), finish (`status: "completed"`), soft-delete
  (`status: "deleted"`), link deps (`addBlocks` / `addBlockedBy`), edit text.
- `list_tasks` — read the current ordered list.
- `get_task` — fetch one by id.

The tools live in the `tasks` group — default-loaded.

### Discipline (baked into the tool prompts)

- Use tasks when work is multi-step (3+ distinct actions), complex, or
  explicitly requested. Skip tasks for trivial single-step work.
- Mark `in_progress` **before** starting, not after.
- Mark `completed` only when the work is fully done — no half-finished
  implementations, no "tests are failing but…".
- Found a new dependency mid-work? Add it with `addBlockedBy`, don't replan
  silently.
- Subagent jobs: include enough detail in `description` that another agent
  could pick it up cold. A subagent claims by `update_task({ owner: self })`.

### Concurrency

Tasks live in SQLite (table `tasks`); writes go through a per-list mutex
(`packages/gateway/src/tasks/mutex.ts`) so concurrent subagents claiming
tasks don't clobber each other. Read-modify-write outside that path is a bug
— go through `TaskStore` (`packages/gateway/src/tasks/store.ts`).

### Scope

`task_list_id` is derived from the session-tree root. A subagent inherits its
parent's task list automatically.

### Source

- Store + mutex: `packages/gateway/src/tasks/`
- Tool surface: `packages/tools/src/tasks/`
- Tool prompts (load-bearing for agent behaviour):
  `packages/tools/src/tasks/prompt.ts`
- Protocol: `packages/protocol/src/namespaces/tasks.ts`

---

## Ask-user questions

Structured multiple-choice questions with channel-native rendering: Discord
buttons, dashboard cards, CLI select, etc. The agent calls **one tool**; the
channel turns it into native UX.

### Tool

```
ask_user({
  questions: [{
    header: "Auth method",                // short chip label
    question: "Which auth flow?",          // ends in "?"
    options: [
      { label: "OAuth (Recommended)",
        description: "Standard, slower setup",
        preview: "..." },                  // optional markdown/HTML snippet
      { label: "API key",
        description: "Faster, less secure" },
    ],
    multiSelect: false,                    // default false
  }],
  timeoutSeconds: 120,                     // optional, channel/policy default
  allowCustom: true,                       // default true — "Other" always shown
})
```

Returns: `answers` keyed by question text, plus `status: "answered" |
"timed_out" | "cancelled"`.

### Rules

- 1–4 questions per call; bundle related sub-questions instead of asking
  serially.
- 2–4 options each, mutually exclusive (unless `multiSelect`).
- Order with the recommended choice first, labelled `(Recommended)`.
- **Don't include a literal "Other"** — the channel always surfaces one.
- Use it for clarification or a real decision between concrete options.
- **Don't** use it for "are you sure?" / "should I proceed?" — just act.
- Use `preview` when the user benefits from seeing the artifact (mockup, code
  snippet, config diff). Skip for pure-preference questions.

### How it flows

1. Tool call → gateway writes a row in `questions`, broadcasts `questions.asked`.
2. Every subscribed client renders. First valid answer wins.
3. Gateway broadcasts `questions.answered`, the tool returns to the agent.
4. On timeout: `questions.timed_out`; the tool returns and you see the result.

### Channel capability degradation

A channel declares what it supports (`supportsPreview`, `supportsMultiSelect`,
`maxOptions`, `supportsFreeText`). The gateway **never silently drops options**
— if you ask for 5 options on a channel capped at 4, the tool call is rejected
with a clear error so you can re-shape the question.

### Source

- Store: `packages/gateway/src/questions/store.ts`
- Tool surface: `packages/tools/src/questions/`
- Protocol: `packages/protocol/src/namespaces/questions.ts`
- Discord renderer: `packages/channel-discord/src/` (look for `ask`/`questions`
  handling in `channel.ts`)
