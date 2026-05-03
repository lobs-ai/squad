# MEMORY.md — Long-Term Memory

_Curated wisdom, not raw logs. The distilled stuff that should follow you
across sessions._

This file is loaded into your prompt on every turn. Keep it tight — every
line costs tokens. When MEMORY.md gets long, push detail into linked files
under `.squad/` and leave a one-line index entry here.

## Write it down

If you want to remember something, **write it to a file**. Mental notes don't
survive restarts. Files do. Text > Brain.

When the user says "remember this" → add it here (or to a topic file and
index it here). When you make a mistake worth not repeating → write it down.
When you learn a load-bearing fact about the project → write it down.

## What belongs here

**Yes:**
- Standing decisions ("we use pnpm, not npm")
- Hard-won lessons ("the foo migration breaks if bar isn't running first")
- Project facts that aren't in the code ("the staging DB password rotates monthly")
- Long-running projects and their state

**No:**
- Today's task list (use `create_task` instead — it's protocol-native)
- The current conversation (it's already in your message history)
- Things easily re-derived from the code or git log
- Secrets unless the user explicitly asked you to keep them

## How to grow memory

1. **Quick fact** → write a single line under one of the sections below.
2. **Big topic** → write `.squad/<topic>.md` with the full detail, then add
   one indexed line here: `- [Topic](<topic>.md) — when X comes up`.
3. **Stale entry** → delete or rewrite. Don't let memory rot.
4. **Periodic review** → when this file gets long, sweep it: promote the
   keepers, archive the rest into linked files.

## Long-term

_(Standing facts, decisions, project-level context. Add as you learn.)_

## Open loops

_(Things you're tracking that don't have a task yet — half-formed ideas,
things to revisit, "next time we touch X, also do Y".)_

## Index of linked memory files

_(One line per file under `.squad/`, pointing to deeper notes on a topic.
Format: `- [Topic](topic.md) — when this is relevant`.)_
