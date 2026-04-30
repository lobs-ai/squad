# Cron / Routines: unified design

The squad cron system runs scheduled work on a single-process daemon. It
combines the prompt-centric ergonomics of hermes-agent with the operational
rigor (state separation, telemetry, stagger, failure backoff, payload
flexibility) of openclaw.

The existing `routines/` module is the seed. This design extends it
without breaking the current `RoutineRecord` shape — old fields stay,
new fields are optional with sane defaults.

## Storage

```
<data_dir>/cron/
  jobs.json              # config (lives in git if you want)
  state.json             # runtime fields: nextRunAt, lastRunAt, consecutiveErrors
  runs/<jobId>.jsonl     # per-job run telemetry, append-only
  .tick.lock             # advisory lock (open() O_EXCL); single writer per tick
```

Config and state are split so editing a job from the dashboard or git
doesn't churn the runtime fields. Each tick rewrites `state.json`
atomically (write to `.tmp`, rename). Run logs are JSONL, pruned to the
last N (default 200) per job.

## Job schema

A job is the union of three orthogonal choices: **when** (schedule),
**what** (payload), **where** (session target + delivery), plus
per-job execution overrides.

```ts
type CronJob = {
  id: string;
  name: string;            // unique within store
  enabled: boolean;
  schedule: Schedule;
  payload: Payload;
  session: SessionTarget;
  delivery: Delivery;      // existing RoutineDelivery
  execution: Execution;    // model, fallbacks, tools, timeout
  failure?: { alertChannel?: string; cooldownSec: number };
  createdAt: string;
  // Backward-compat mirror of legacy RoutineRecord fields:
  cron?: string;           // populated when schedule.kind === "cron"
  prompt?: string;         // populated when payload.kind === "prompt"
  model?: string | null;   // mirrors execution.model
};

type Schedule =
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "interval"; everyMs: number; anchor?: string }
  | { kind: "once"; at: string }; // ISO timestamp

type Payload =
  | { kind: "prompt"; text: string; skills?: string[] }
  | { kind: "agentTurn"; messages: Array<{ role: "user" | "system"; text: string }> }
  | { kind: "script"; command: string; args?: string[]; cwd?: string };
//  ^ "script" runs in a child process — no LLM, no agent. Output is
//    captured into the run log and (optionally) delivered.

type SessionTarget =
  | { kind: "new" }                       // fresh session per fire (default)
  | { kind: "isolated" }                  // subagent — no parent, ephemeral
  | { kind: "session"; sessionId: string };// append turns to a fixed session

type Execution = {
  model?: string | null;     // overrides config.llm.primary
  fallbacks?: string[];      // overrides config.llm.fallbacks
  toolsAllow?: string[];     // restrict tool registry for this job
  timeoutSec?: number;       // total runner timeout (default 300)
};
```

State (kept in `state.json`, never sent over the wire as part of job
config):

```ts
type CronState = Record<string, {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  consecutiveErrors: number;
}>;
```

Run-log entry (one JSON object per line in `runs/<jobId>.jsonl`):

```ts
type CronRunLog = {
  ts: string;             // when run started
  status: "ok" | "error" | "skipped";
  durationMs: number;
  sessionId?: string;     // populated for prompt/agentTurn/session payloads
  payloadKind: Payload["kind"];
  output?: string;        // truncated; full output stays in session messages
  error?: string;
  delivery?: { kind: string; ok: boolean; error?: string };
  tokens?: { in: number; out: number };
};
```

## Schedule semantics

Three primitives cover everything users actually want:

- **cron** — five-field crontab (subset already in `matchesCron`); `tz`
  defaults to system. `staggerMs` is added to the matched minute via
  `sha256(seed + jobId)` so a hundred jobs at 09:00 don't all fire on
  the same tick.
- **interval** — `everyMs` since `anchor` (or job creation if absent).
  Useful for "every 30m" without forcing the user to convert to cron.
- **once** — fire at `at` and disable.

All three follow the same lifecycle:

1. `nextRunAt` is computed at create / after fire.
2. On each tick, jobs whose `nextRunAt` is in the past are eligible.
3. **Adaptive grace** — for recurring jobs we accept missed fires
   within `min(period/2, 2h)` (clamped to 2 minutes minimum). After
   the grace window we skip the run and recompute `nextRunAt` to the
   next future occurrence (with status `"skipped"`). One-shots get a
   flat 120-second grace.
4. **Advance before execute** — `nextRunAt` is rewritten *before* the
   job runs, so a daemon crash mid-fire does not re-fire on next boot.
   At-most-once semantics, intentionally chosen over at-least-once.

## Payload semantics

- **prompt** — the most common case. The text is run as a user turn
  through the standard agent loop (`runChatTurn`). Optional `skills`
  are joined into the system prompt.
- **agentTurn** — explicit messages. Useful when the job needs to set
  a system message or chain user/system turns.
- **script** — bypass the agent entirely. The command runs as a child
  process; stdout/stderr are captured into the run log. This covers
  hermes-style "data collection" without the wake-gate JSON dance —
  if you want to turn the script's output into a prompt, use the
  delivery hook (or chain by calling `routines.run_now` from inside
  the script).

### Wake gates

Borrowed from hermes:

- If the first line of payload output is `[SILENT]`, delivery is
  skipped (run still logged).
- If the script payload exits 0 with output `{"wakeAgent": false}`,
  the script is treated as a no-op (skipped status).

## Session targeting

- `new` (default) — `sessions.create()` per fire, model + fallbacks
  from `execution` or config defaults.
- `isolated` — a subagent under no parent; gone after the run. Use for
  side jobs that should not touch any visible session history.
- `session: { sessionId }` — appends the prompt as a user turn to an
  existing session. Useful for "every morning, ask my main session
  what's on the calendar."

## Per-job execution overrides

`execution.model` / `fallbacks` / `toolsAllow` / `timeoutSec` all
override the gateway defaults *for that run only*. The model name
flows into `sessions.create({ model })` and ultimately into the
runner. This is the headline feature beyond the current
single-`model` field on `RoutineRecord` — `RoutineRecord.model`
becomes a back-compat mirror of `execution.model`.

## Delivery

The existing `RoutineDelivery` (silent | dashboard | discord) is kept
as-is. The dashboard subscribes to `routines.fired/<sessionId>` for
live updates. The plan for adding webhook delivery later is a new
`{ kind: "webhook", url: string, headers?: Record<string,string> }`
variant — the delivery layer already routes by `kind`.

## Failure handling

- `consecutiveErrors` increments on each error; resets on success.
- After 3+ consecutive failures, an alert is emitted to
  `failure.alertChannel` (if set), gated by `failure.cooldownSec`.
- Errors do not disable the job. Operators decide.

## Concurrency

- One scheduler per gateway process. The `.tick.lock` prevents
  overlapping ticks if the daemon is somehow started twice.
- A bounded thread pool (default 4) runs eligible jobs in parallel.
  Each fire is independent — there is no per-job lock; if a job is
  still running when its next fire arrives, we log "previous run
  still active, skipping" and advance.

## API surface

Existing methods extended (params still backward-compatible — old
clients can keep passing `cron`/`prompt`/`model`):

- `routines.list` → returns full `CronJob[]` (legacy fields populated).
- `routines.create` → accepts either legacy flat shape OR the new
  structured shape. The store normalizes internally.
- `routines.update` → same.
- `routines.delete` → unchanged.
- `routines.run_now` → unchanged.

New methods:

- `routines.runs` — paginated run-log query; filter by `jobId`,
  `status`, `since`.
- `routines.tail` — most-recent N entries for a job.

Events are unchanged: `routines.fired/<sessionId>`,
`routines.changed`. The dashboard's existing subscriptions keep
working.

## Migration

The current in-memory `RoutineStore` is swapped for a file-backed one
that loads jobs.json on boot. The first boot after this change
creates an empty jobs.json — there are no existing routines to
migrate. Plugin-supplied routines still call `adoptFromPlugin`; they
land as `{ schedule: cron, payload: prompt, session: new }`.

## What's intentionally out of scope (v1)

- Distributed scheduling across multiple gateway processes
- Webhook delivery (sketched, not built)
- Pre-run script injection as context for a prompt payload — use the
  `script` payload kind and chain via `routines.run_now` if needed
- Cron expression timezones beyond system local
