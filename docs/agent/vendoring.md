# Vendoring

Two packages are **copied** from `lobs/agentic`, not imported:

- `packages/runner/` — the agent loop (`agent-loop.ts`, `hooks.ts`,
  `session.ts`, `context-engine.ts`, etc.)
- `packages/llm/` — `LLMClient`, `parseModelString`, `inferProvider`,
  `createClient`, and the three provider implementations (anthropic, openai,
  openai-compatible).

A small piece of `packages/tools/` is also vendored (`base-tool.ts`,
`registry.ts`, `types.ts`) — the rest of `packages/tools/` is Squad-original.

## Why

One of Squad's three load-bearing claims: **vendored, not imported — one
repo owns the loop.** Upstream velocity in `agentic` can't break Squad;
re-sync is a deliberate act, reviewed line by line. The tradeoff: we pick up
upstream bug fixes on our schedule, not theirs.

## Rules (load-bearing)

1. Every vendored file starts with a header comment:
   ```ts
   // Vendored from lobs/agentic at <commit-sha>
   // Original path: packages/<pkg>/src/<file>
   // Last synced: <YYYY-MM-DD>
   ```
2. `VENDOR.md` at the repo root is the source of truth for what's vendored
   and from which commit.
3. **Editing a vendored file is fine** — note the change in the file header
   and in the next re-sync PR. Local edits surviving a re-sync is a feature,
   not a bug.
4. **Do not** add `@agentic/*` (or `@lobs/agentic`) to any `package.json`.
5. Re-sync = a PR titled `vendor: resync from agentic <short-sha>` that
   updates `VENDOR.md`, the file headers, and a changelog note covering any
   behavioural deltas.

## What's deliberately NOT vendored

- `agentic/packages/runner/src/session.ts` is vendored, but Squad's
  **persistent** session store is its own thing (`packages/gateway/src/db/`).
  The runner's `Session` class is in-memory only.
- agentic's "runtime as separate WS service" layer. Squad runs the loop
  in-process in the gateway, intentionally. Don't bring it back without a
  real reason.
- agentic's resilient-client / circuit-breaker / key-manager machinery.
  Squad does retries + fallbacks outside the runner — see
  `packages/gateway/src/rotating-client.ts` and `packages/llm/src/chain.ts`.
  This is the one local edit on `agent-loop.ts` (it imports `createClient`
  instead of `createResilientClient`).

## Re-sync cadence

No fixed schedule. Re-sync when:

- A bug fix in `agentic` fixes a real Squad issue.
- A feature in `agentic` unblocks something on the roadmap.
- More than six months have passed since the last sync.

## Source

- `VENDOR.md` (repo root) — pinned commit SHA per file
- `packages/runner/src/` — the vendored runner
- `packages/llm/src/` — the vendored LLM clients
- `packages/tools/src/{base-tool,registry,types}.ts` — the vendored tool core
