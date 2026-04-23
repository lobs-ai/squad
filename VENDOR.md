# VENDOR.md

Squad vendors (copies) a small set of files from [`lobs/agentic`](https://github.com/lobs-ai/agentic) instead of taking a runtime dependency on it. This document is the source of truth for which files are vendored, from which commit, and how to re-sync.

## Why vendor?

One of Squad's three load-bearing claims is **"vendored, not imported — one repo owns the loop."** Upstream velocity in `agentic` can't break Squad; re-sync is a deliberate act, reviewed line by line. The tradeoff is that we pick up upstream bug fixes on our schedule, not theirs.

## Rules

1. Every vendored file begins with a header comment of the form:
   ```ts
   // Vendored from lobs/agentic at <commit-sha>
   // Original path: packages/<pkg>/src/<file>
   // Last synced: <YYYY-MM-DD>
   ```
2. This document lists every vendored file with its pinned commit.
3. Re-syncing is a pull request titled `vendor: resync from agentic <short-sha>` with:
   - the new commit SHA in this document,
   - updated header comments in every touched file,
   - a changelog note covering any behavioral deltas.
4. No vendored file is edited without a corresponding note in the file's header and a changelog entry in the re-sync PR. Local edits on top of vendored code are fine — they just need to be visible.
5. We do not list `@lobs/agentic` (or any `agentic/*` package) as a dependency in any `package.json`.

## Vendored files (v1)

Filled in as we import. Track the source commit here the moment a file is copied.

### `packages/runner/src/`

| File                  | Source path in agentic                  | Commit | Synced |
|-----------------------|------------------------------------------|--------|--------|
| `agent-loop.ts`       | `packages/runner/src/agent-loop.ts`      | _TBD_  | _TBD_  |
| `types.ts`            | `packages/runner/src/types.ts`           | _TBD_  | _TBD_  |
| `hooks.ts`            | `packages/runner/src/hooks.ts`           | _TBD_  | _TBD_  |
| `context-engine.ts`   | `packages/runner/src/context-engine.ts`  | _TBD_  | _TBD_  |
| `loop-detector.ts`    | `packages/runner/src/loop-detector.ts`   | _TBD_  | _TBD_  |

### `packages/llm/src/`

| File                              | Source path in agentic                                   | Commit | Synced |
|-----------------------------------|-----------------------------------------------------------|--------|--------|
| `types.ts`                        | `packages/llm/src/types.ts`                              | _TBD_  | _TBD_  |
| `client.ts`                       | `packages/llm/src/client.ts`                             | _TBD_  | _TBD_  |
| `providers/anthropic.ts`          | `packages/llm/src/providers/anthropic.ts`                | _TBD_  | _TBD_  |
| `providers/openai.ts`             | `packages/llm/src/providers/openai.ts`                   | _TBD_  | _TBD_  |
| `providers/openai-compatible.ts`  | `packages/llm/src/providers/openai-compatible.ts`        | _TBD_  | _TBD_  |

### `packages/tools/src/`

| File              | Source path in agentic                | Commit | Synced |
|-------------------|-----------------------------------------|--------|--------|
| `base-tool.ts`    | `packages/tools/src/base-tool.ts`      | _TBD_  | _TBD_  |
| `registry.ts`     | `packages/tools/src/registry.ts`       | _TBD_  | _TBD_  |

## Files we deliberately do NOT vendor

- `packages/runner/src/session.ts` — Squad has its own SQLite session store.
- Anything in agentic's runtime layer (WS runtime service) — v1 runs the loop in-process in the gateway.

## Re-sync cadence

No fixed schedule. Re-sync when one of these is true:

- A bug fix in `agentic` fixes a real Squad issue.
- A feature in `agentic` unblocks something on Squad's roadmap.
- More than six months have passed since the last re-sync — do a pass, even if nothing specific is driving it.

A re-sync always reads agentic's changelog first, picks the commit explicitly, and flows through this document.
