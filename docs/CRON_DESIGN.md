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
  | {
      kind: "prompt";
      messages: Array<{ role: "user" | "system"; text: string }>;
      skills?: string[];
    }
  | { kind: "script"; command: string; args?: string[]; cwd?: string }
  | {
      kind: "scriptThenPrompt";
      command: string;
      args?: string[];
      cwd?: string;
      prompt: {
        messages: Array<{ role: "user" | "system"; text: string }>;
        skills?: string[];
      };
    };
//  ^ "script" runs in a child process — no LLM, no agent. Output is
//    captured into the run log and (optionally) delivered.
//  ^ "scriptThenPrompt" spawns the script first, then conditionally
//    runs an agent turn fed by the script's stdout.

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
  sessionId?: string;     // populated when a session is created/reused (any LLM payload)
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

Three payload kinds — `prompt`, `script`, `scriptThenPrompt`. One full
agent loop ("turn") in the prompt-style payloads is *not* a single LLM
call: it is one invocation of `runChatTurn`, which can iterate, call
tools, and produce many internal steps until it stops. Bound it with
`execution.timeoutSec` (default 300s).

### `prompt`

Run an agent turn. `messages` is an ordered list of role-tagged text:
user messages are concatenated (`\n\n`-joined) into the user turn;
system messages are folded into a per-run system-prompt override.
`skills` (optional) names skill ids whose instructions get appended to
that override (`Skills enabled for this routine: …`).

Use `session: { kind: "session", sessionId }` if you want the agent to
*continue* an existing chat across fires (e.g. "every morning, ask my
main session what's on the calendar").

### `script`

Bypass the agent entirely. The command runs as a child process spawned
via Node's `child_process.spawn(command, args, { cwd })`:

- **Where it runs.** `cwd` defaults to the gateway workspace dir
  (`ExecutorDeps.workspaceDir` — typically the directory the gateway
  was started in). Provide an absolute path in `cwd` to override.
- **Resolution.** `command` is resolved via the gateway process's
  `PATH`, or pass an absolute path. There is no shell — pass a shell
  invocation explicitly (`command: "sh", args: ["-c", "…"]`) if you
  need pipes, redirects, or globs.
- **Environment.** The child inherits the gateway's `process.env`. No
  per-job env injection (yet); use a wrapper script if you need
  per-job secrets.
- **Output capture.** stdout *and* stderr are merged in arrival order
  into one buffer, capped at 64 KiB. Anything past the cap is dropped.
- **Timeout.** The child is killed (SIGKILL) at `min(execution.timeoutSec,
  300s)` — script runs are hard-capped at 5 minutes regardless of the
  per-job override.
- **Exit status.** Exit 0 → run status `"ok"`. Non-zero → run status
  `"error"` with `error: "exit code N"`. The script's output is still
  captured and logged either way.
- **Wake gates.** Two ergonomic shortcuts for "ran fine but nothing to
  deliver":
  - First line of stdout is `[SILENT]` → delivery is suppressed; the
    run is still logged with whatever status the exit code produced.
  - Exit 0 plus stdout containing `{"wakeAgent": false}` (any line) →
    status flips to `"skipped"`, delivery suppressed.

Scripts have no session and no LLM — `sessionId` is null in the run
log, `tokens` is unset.

### `scriptThenPrompt`

Run a script, then conditionally hand its stdout to an agent turn.
Same script invocation rules as `script` (cwd, env, capture cap,
SIGKILL at 5 minutes). The conditional uses **exit code only** — no
text wake-gates. Rules:

| Script result                  | Run status   | Agent runs? | Notes                                            |
| ------------------------------ | ------------ | ----------- | ------------------------------------------------ |
| exit 0, **non-empty** stdout   | `ok`         | yes         | stdout is spliced into the prompt (see below)    |
| exit 0, **empty** stdout       | `skipped`    | no          | the "nothing to do" path; delivery suppressed    |
| non-zero exit                  | `error`      | no          | `error: "exit code N"`; delivery suppressed      |

When the agent runs, the script's stdout is woven into the inner
`prompt.messages`:

- Any occurrence of the literal placeholder `{{output}}` (whitespace
  inside the braces is tolerated) in any message's text is replaced
  with the script's full captured stdout.
- If *no* message contained `{{output}}`, the stdout is appended as a
  final `{ role: "user", text: <stdout> }` message — so the agent
  always sees the trigger content even if you forget the placeholder.

System messages and `skills` on the inner `prompt` work the same way
they do for the standalone `prompt` payload. The exit-code rule
replaces the `[SILENT]` / `{"wakeAgent": false}` gates — if your
script wants to short-circuit the agent, just exit 0 with no stdout
(or a non-zero code if it's an error condition).

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

Each cron job's `delivery` field tells the gateway where to send the
run's output. The schema is **open** — built-in kinds (`silent`,
`dashboard`, `discord`) are typed precisely; arbitrary `{ kind: string,
... }` payloads are accepted so plugin-registered handlers (slack,
webhook, email, …) can be targeted without changing the protocol.

### Built-in kinds

- `silent` — run is logged, nothing is sent anywhere.
- `dashboard` — the resulting session opens in the dashboard chat UI.
  Implicit; the dashboard subscribes to `routines.fired/<sessionId>`.
- `discord` — `{ kind: "discord", channelId: string, guildId?: string }`.
  Posts the run output into a Discord channel via the channel-discord
  plugin's registered handler.

### Plugin-registered kinds

Any plugin can extend delivery by calling
`api.delivery.register(kind, handler)` during plugin registration.
At fire time, the executor builds a `DeliveryContext` and the
`DeliveryRegistry` routes it by `kind`:

```ts
api.delivery.register("slack", async (ctx) => {
  // ctx.delivery is the routine's delivery object — extras are passed through
  const { channel, emoji } = ctx.delivery as {
    channel?: string;
    emoji?: string;
  };
  await postToSlack(channel, ctx.output, { emoji });
  return { ok: true };
});
```

The routine targets it with:

```jsonc
{ "delivery": { "kind": "slack", "channel": "#alerts", "emoji": ":robot_face:" } }
```

A handler that returns `{ ok: false, error }` records the failure on
the run-log entry's `delivery` field but does not change `lastStatus`.
If no handler is registered for the kind at fire time, delivery fails
with `"no delivery handler registered for kind \"X\""`. The wake-gate
(`[SILENT]` / `{"wakeAgent": false}`) is honored before any handler is
invoked.

### Targeting different channels per job

Each cron job has its own `delivery` config — to fan out to two
different channels, create two jobs with the same payload but
different `delivery.channelId` (or different `kind`). The tools tool
schema accepts this directly via `create_cron_job`.

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
- Cron expression timezones beyond system local
- Per-job env-var injection for scripts (use a wrapper)
