# Squad — Agent-Facing Documentation

You are an agent running on a **Squad gateway**. This directory exists so you
don't have to grep your own source code to figure out how the system around
you works. Read the page that matches the question.

## When to read what

| If you're trying to answer…                                       | Open                              |
|-------------------------------------------------------------------|-----------------------------------|
| What is Squad? How are the pieces wired together?                 | [architecture.md](architecture.md) |
| How do subagents / tasks / ask-user actually work?                | [primitives.md](primitives.md)     |
| Why don't I see tool X? How do I unlock more tools?               | [tool-groups.md](tool-groups.md)   |
| How do plugins extend the gateway? What can a plugin register?    | [plugins.md](plugins.md)           |
| How do plugins inject conditional prompt hints into tools?        | [plugins.md](plugins.md) § fragments |
| How does Discord (or any channel) talk to the gateway?            | [channels.md](channels.md)         |
| What's on the wire? How do I add a new method/event?              | [protocol.md](protocol.md)         |
| What exactly does the gateway do per turn? Where is X stored?     | [gateway-internals.md](gateway-internals.md) |
| Where do messages, tasks, memory live in SQLite?                  | [storage-and-memory.md](storage-and-memory.md) |
| Why are `runner` and `llm` copies, not deps?                      | [vendoring.md](vendoring.md)       |

## Source-of-truth anchors

These are the files this directory summarises. When the docs disagree with the
code, the code wins — open the file and trust it. Paths are relative to the
Squad repo root.

- `SPEC.md` — the long-form design doc (architecture, primitives, roadmap).
- `AGENTS.md` — rules for coding agents working in this repo.
- `PLAN.md` — the v1 phase plan and what shipped.
- `VENDOR.md` — the pinned commit list for vendored files.
- `packages/protocol/src/namespaces/` — every wire method/event with a Zod schema.
- `packages/gateway/src/agent-prompt.ts` — what your system prompt actually
  contains, and how SOUL/USER/MEMORY get loaded.
- `packages/gateway/src/runs.ts` — what happens between "user message arrives"
  and "agent loop starts".
- `packages/tools/src/prompt-context.ts` + `packages/tools/src/prompt-slots.ts` —
  the live PromptContextStore + canonical fragment slot taxonomy. Tool
  descriptions render against this every turn; plugins extend it via
  `api.promptFragments.register`.
- `packages/gateway/src/db/migrations.ts` — the SQLite schema in append-only form.

## Reading a page

Use the `read` tool against the path of the page you want
(e.g. `docs/agent/protocol.md`). If you don't know where the Squad checkout
lives on this machine, `find_files` for `docs/agent/INDEX.md` first — once
you have one path the rest are siblings.

If a question isn't covered here and you have to grep source to answer it,
write what you learned to a new file in this directory — the next agent (you,
next session) shouldn't have to re-derive it.
