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

## Vendored files

All vendored files are currently pinned to agentic `7daf6df` (synced 2026-04-23).

### `packages/runner/src/`

| File                      | Source path in agentic                       | Commit    | Synced     |
|---------------------------|-----------------------------------------------|-----------|------------|
| `agent-loop.ts`           | `packages/runner/src/agent-loop.ts`           | `7daf6df` | 2026-04-23 |
| `types.ts`                | `packages/runner/src/types.ts`                | `7daf6df` | 2026-04-23 |
| `hooks.ts`                | `packages/runner/src/hooks.ts`                | `7daf6df` | 2026-04-23 |
| `context-engine.ts`       | `packages/runner/src/context-engine.ts`       | `7daf6df` | 2026-04-23 |
| `context-manager.ts`      | `packages/runner/src/context-manager.ts`      | `7daf6df` | 2026-04-23 |
| `loop-detector.ts`        | `packages/runner/src/loop-detector.ts`        | `7daf6df` | 2026-04-23 |
| `tool-registry.ts`        | `packages/runner/src/tool-registry.ts`        | `7daf6df` | 2026-04-23 |
| `session.ts`              | `packages/runner/src/session.ts`              | `7daf6df` | 2026-04-23 |
| `session-transcript.ts`   | `packages/runner/src/session-transcript.ts`   | `7daf6df` | 2026-04-23 |

`session.ts` and `session-transcript.ts` are the runner's **in-memory** session
abstractions — not Squad's SQLite session store. They are required for
`agent-loop.ts` to run. Squad's `packages/gateway/src/sessions/` persists its
own `sessions` / `messages` / `tool_calls` rows via runner hooks and is the
source of truth across restarts.

**Local edit:** `agent-loop.ts` imports `createClient` instead of
`createResilientClient`. Squad does not vendor agentic's resilient-client /
circuit-breaker / key-manager machinery — retries and fallbacks live outside
the runner. See the header comment in that file.

### `packages/llm/src/`

| File                              | Source path in agentic                              | Commit    | Synced     |
|-----------------------------------|------------------------------------------------------|-----------|------------|
| `types.ts`                        | `packages/llm/src/types.ts`                          | `7daf6df` | 2026-04-23 |
| `client.ts`                       | `packages/llm/src/client.ts`                         | `7daf6df` | 2026-04-23 |
| `utils.ts`                        | `packages/llm/src/utils.ts`                          | `7daf6df` | 2026-04-23 |
| `providers/anthropic.ts`          | `packages/llm/src/providers/anthropic.ts`            | `7daf6df` | 2026-04-23 |
| `providers/openai.ts`             | `packages/llm/src/providers/openai.ts`               | `7daf6df` | 2026-04-23 |
| `providers/openai-compatible.ts`  | `packages/llm/src/providers/openai-compatible.ts`    | `7daf6df` | 2026-04-23 |

### `packages/tools/src/`

| File              | Source path in agentic                | Commit    | Synced     |
|-------------------|-----------------------------------------|-----------|------------|
| `types.ts`        | `packages/tools/src/types.ts`          | `7daf6df` | 2026-04-23 |
| `base-tool.ts`    | `packages/tools/src/base-tool.ts`      | `7daf6df` | 2026-04-23 |
| `registry.ts`     | `packages/tools/src/registry.ts`       | `7daf6df` | 2026-04-23 |

## Files we deliberately do NOT vendor

- Anything in agentic's runtime layer (the WS runtime service) — Squad runs the loop in-process in the gateway.
- agentic's resilient-client / circuit-breaker / key-manager machinery — Squad does retries + fallbacks outside the runner (`packages/gateway/src/rotating-client.ts`, `packages/llm/src/chain.ts`).

Note: the runner's in-memory `session.ts` / `session-transcript.ts` **are** vendored (the loop needs them), but Squad's **persistent** session store is its own thing in `packages/gateway/src/db/` — not agentic's.

## Re-sync cadence

No fixed schedule. Re-sync when one of these is true:

- A bug fix in `agentic` fixes a real Squad issue.
- A feature in `agentic` unblocks something on Squad's roadmap.
- More than six months have passed since the last re-sync — do a pass, even if nothing specific is driving it.

A re-sync always reads agentic's changelog first, picks the commit explicitly, and flows through this document.
