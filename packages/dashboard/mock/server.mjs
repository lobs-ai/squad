#!/usr/bin/env node
/**
 * Mock Squad gateway: enough of the WebSocket protocol, with canned data and
 * a short live storyline, that every dashboard view renders without a real
 * gateway, a model, or an API key.
 *
 *   pnpm --filter @squad/dashboard mock          # ws://127.0.0.1:8092/ws
 *   PORT=8093 pnpm --filter @squad/dashboard mock
 *
 * The dashboard always connects to `/ws` on the origin that served it, so run
 * the dev server with the gateway routes proxied through to this process:
 *
 *   SQUAD_GATEWAY=http://127.0.0.1:8092 pnpm --filter @squad/dashboard dev
 *
 * Auth: any non-empty token is accepted, from `?token=` or a Bearer header,
 * the two places the gateway reads it. "pair this browser" works too: every
 * pairing code approves itself after a moment, as if an operator had run
 * `squad pair browser <code>`.
 *
 * What is canned: a PR review where the main agent fans out to three
 * subagents (each with its own model and budget) over one shared task list,
 * an open ask_user question, a pending approval, routines, plugins, logs.
 *
 * What is live: once the first dashboard subscribes, the reviewer subagent
 * streams its findings for about 45 seconds and finishes its task. A routine
 * fires every minute and log lines trickle in. Answering the question,
 * deciding the approval, and sending a chat message each play out a scripted
 * turn. Nothing is persisted; restart the mock to reset.
 *
 * No dependencies. The WebSocket layer is a minimal RFC 6455 server on
 * node:http (text frames, fragmentation, ping/pong, close), so the mock runs
 * from a checkout where `ws` is not installed in this package.
 */

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8092);
const HOST = process.env.HOST || "127.0.0.1";
const SQUAD = "demo";
const VERSION = "0.0.0-demo";

/** When the mock started. Every seeded timestamp is relative to this. */
const T0 = Date.now();
/** When the pretend gateway started: a few hours before the mock did, so uptime reads like a real one. */
const STARTED = T0 - (3 * 3600 + 12 * 60) * 1000;

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
/** A timestamp `min` minutes and `sec` seconds before the mock started. */
const ago = (min, sec = 0) => new Date(T0 - (min * 60 + sec) * 1000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolUseId = () => `toolu_${crypto.randomBytes(9).toString("hex")}`;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Each connected dashboard: its socket and the topic patterns it subscribed
 * to. Declared up here because seeding the log buffer already publishes.
 */
const clients = new Set();
const patternCache = new Map();

// ---------------------------------------------------------------------------
// Models, subagent definitions, config
// ---------------------------------------------------------------------------

// Ids in the provider/model form the gateway uses, and ones the dashboard's
// price table knows, so the cost columns show numbers instead of dashes.
const M = {
  opus: "anthropic/claude-opus-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  haiku: "anthropic/claude-haiku-4-5",
  gpt: "openai/gpt-4.1",
  mini: "openai/gpt-4o-mini",
};

const models = [
  { id: M.opus, displayName: "Claude Opus 4.5", provider: "anthropic", contextWindow: 200_000, notes: "careful, slower" },
  { id: M.sonnet, displayName: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200_000, notes: "default" },
  { id: M.haiku, displayName: "Claude Haiku 4.5", provider: "anthropic", contextWindow: 200_000, notes: "fast, cheap" },
  { id: M.gpt, displayName: "GPT-4.1", provider: "openai", contextWindow: 1_047_576 },
  { id: M.mini, displayName: "GPT-4o mini", provider: "openai", contextWindow: 128_000 },
];

// Three named subagents, deliberately on three different models with three
// different budgets: that per-subagent model and budget is the point of the
// primitive, and the main chat shows both in each spawn result.
const subagentDefs = [
  {
    name: "researcher",
    description: "Reads docs and package registries and reports options with trade-offs",
    model: M.haiku,
    tools: ["web_search", "web_fetch", "read"],
    limits: { maxTokens: 40_000, maxToolCalls: 30, timeoutMs: 5 * 60_000 },
  },
  {
    name: "reviewer",
    description: "Reviews a diff line by line and reports risks in priority order",
    model: M.opus,
    tools: ["read", "grep", "glob", "update_task"],
    limits: { maxTokens: 120_000, maxToolCalls: 60, timeoutMs: 15 * 60_000 },
  },
  {
    name: "tester",
    description: "Runs test suites and summarizes failures with file and line",
    model: M.gpt,
    tools: ["exec", "read", "update_task"],
    limits: { maxTokens: 30_000, maxToolCalls: 20, timeoutMs: 10 * 60_000 },
  },
];
const defByName = new Map(subagentDefs.map((d) => [d.name, d]));

function budgetLine(def) {
  const l = def.limits;
  return `subagent ${def.name} · ${def.model.split("/")[1]} · budget ${l.maxTokens / 1000}k tokens · ${l.maxToolCalls} tool calls · ${l.timeoutMs / 60_000} min`;
}

/**
 * The on-disk config.json, as `admin.config.full` returns it. Settings binds
 * to this and writes back through `admin.config.set`, so it is the one copy:
 * `admin.config` and `admin.identity` are derived from it rather than kept
 * alongside, and an edit in Settings shows up everywhere it should.
 */
const config = {
  server: {
    squad_name: SQUAD,
    host: HOST,
    port: PORT,
    data_dir: "~/.squad/squads/demo",
    workspace_dir: "~/.squad/squads/demo/workspace",
    build: "mock",
  },
  llm: {
    primary: M.sonnet,
    fallbacks: [M.gpt],
    providers: {
      anthropic: { api_key_env: "ANTHROPIC_API_KEY" },
      openai: { api_key_env: "OPENAI_API_KEY" },
    },
  },
  subagents: { max_concurrent_global: 8, max_concurrent_per_parent: 4, max_tree_depth: 3 },
  policy: {
    approvals: {
      default: "tag-match",
      require_for_tags: ["write", "exec", "network"],
      require_for_tools: [],
      timeout_seconds: 3600,
    },
  },
  chat: { delivery: { mode: "interrupt", max_queued: 10, collapse_duplicates: true }, auto_title: true },
  auth: {
    tokens: [
      { label: "dashboard", key_env: "SQUAD_TOKEN", scopes: ["*"] },
      { label: "discord-bot", key_env: "SQUAD_DISCORD_TOKEN", scopes: ["*"] },
    ],
  },
  plugins: [
    { path: "../channel-discord/dist/plugin.js", config: { dm_policy: "allow_list" } },
    "../plugin-google-auth/dist/plugin.js",
    { path: "../plugin-google-calendar/dist/plugin.js", config: { calendar_id: "primary" } },
    "./plugins/weather/dist/plugin.js",
  ],
};

function configPathSegments(path) {
  return path.split(".").filter(Boolean);
}

function setConfigPath(path, value) {
  const segs = configPathSegments(path);
  if (segs.length === 0) throw new RpcError("invalid_params", "path is empty");
  let cur = config;
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] === null || typeof cur[seg] !== "object") cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs.at(-1)] = value;
}

function unsetConfigPath(path) {
  const segs = configPathSegments(path);
  let cur = config;
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] === null || typeof cur[seg] !== "object") return;
    cur = cur[seg];
  }
  if (Array.isArray(cur)) cur.splice(Number(segs.at(-1)), 1);
  else delete cur[segs.at(-1)];
}

const primaryModel = () => (typeof config.llm?.primary === "string" ? config.llm.primary : M.sonnet);
const fallbackModels = () => (Array.isArray(config.llm?.fallbacks) ? config.llm.fallbacks.map((f) => (typeof f === "string" ? f : f.model)) : []);

// ---------------------------------------------------------------------------
// Sessions, transcripts, tasks, questions, approvals
// ---------------------------------------------------------------------------

/** sessionId -> SessionRecord, kept in exactly the wire shape. */
const sessions = new Map();
/** sessionId -> MessageRecord[], oldest first. */
const transcripts = new Map();
/** root sessionId -> Task[]. A subagent shares its root's list, as in the gateway. */
const taskLists = new Map();
const questions = [];
const approvals = [];
const approvalRules = [];

function addSession({
  title,
  model = M.sonnet,
  parent = null,
  subagent = null,
  platform = null,
  remoteId = null,
  status = "idle",
  created = now(),
  updated = created,
  tokensIn = 0,
  tokensOut = 0,
}) {
  const s = {
    id: uuid(),
    parentSessionId: parent,
    subagentDefId: subagent,
    title,
    platform,
    remoteId,
    model,
    fallbacks: parent ? [] : fallbackModels(),
    titleModel: null,
    status,
    deliveryMode: "interrupt",
    tokensIn,
    tokensOut,
    createdAt: created,
    updatedAt: updated,
  };
  sessions.set(s.id, s);
  transcripts.set(s.id, []);
  return s;
}

function rootOf(sessionId) {
  let cur = sessions.get(sessionId);
  while (cur?.parentSessionId && sessions.has(cur.parentSessionId)) cur = sessions.get(cur.parentSessionId);
  return cur?.id ?? sessionId;
}

function append(sessionId, role, content, createdAt = now()) {
  const m = { id: uuid(), sessionId, role, content, createdAt };
  transcripts.get(sessionId).push(m);
  return m;
}

const text = (t) => ({ type: "text", text: t });
const use = (name, input) => ({ type: "tool_use", id: toolUseId(), name, input });
const result = (u, content, isError) => ({
  type: "tool_result",
  toolUseId: u.id,
  content,
  ...(isError ? { isError: true } : {}),
});

function addTask(listId, { subject, description = "", owner = null, status = "pending", activeForm, metadata, created, updated = created }) {
  const t = {
    id: uuid(),
    taskListId: listId,
    subject,
    description,
    ...(activeForm ? { activeForm } : {}),
    owner,
    status,
    blocks: [],
    blockedBy: [],
    ...(metadata ? { metadata } : {}),
    createdAt: created,
    updatedAt: updated,
  };
  if (!taskLists.has(listId)) taskLists.set(listId, []);
  taskLists.get(listId).push(t);
  return t;
}

function link(blocker, blocked) {
  blocker.blocks.push(blocked.id);
  blocked.blockedBy.push(blocker.id);
}

// ---------------------------------------------------------------------------
// The PR review: one main session, three subagents, one shared task list
// ---------------------------------------------------------------------------

// Created first in wall-clock terms is listed last, so the review (the
// newest top-level session) is the one the dashboard opens on.
const pr = addSession({
  title: "Review PR #42: retry with backoff for webhook delivery",
  status: "running",
  created: ago(26),
  updated: ago(0, 40),
  tokensIn: 48_210,
  tokensOut: 6_930,
});
const researcher = addSession({
  title: "researcher · retry libraries",
  model: M.haiku,
  parent: pr.id,
  subagent: "researcher",
  status: "ended",
  created: ago(24, 28),
  updated: ago(13),
  tokensIn: 18_400,
  tokensOut: 2_150,
});
const reviewer = addSession({
  title: "reviewer · src/delivery/retry.ts",
  model: M.opus,
  parent: pr.id,
  subagent: "reviewer",
  status: "running",
  created: ago(24, 27),
  updated: ago(1),
  tokensIn: 31_900,
  tokensOut: 3_420,
});
const tester = addSession({
  title: "tester · delivery test suite",
  model: M.gpt,
  parent: pr.id,
  subagent: "tester",
  status: "running",
  created: ago(24, 26),
  updated: ago(22),
  tokensIn: 4_100,
  tokensOut: 380,
});

// Owners are free-form in the gateway; subagents claim tasks under their own
// name. Every column of the kanban has something in it, including "blocked",
// which the dashboard derives from a non-empty blockedBy.
const T = {
  checkout: addTask(pr.id, {
    subject: "Check out PR #42 and summarize the diff",
    owner: "agent",
    status: "completed",
    metadata: { tags: ["git"] },
    created: ago(25, 50),
    updated: ago(25, 30),
  }),
  research: addTask(pr.id, {
    subject: "Research retry/backoff libraries for Node",
    description: "Maintained, supports AbortSignal and jitter. Compare against the hand-rolled loop in the PR.",
    owner: "researcher",
    status: "completed",
    metadata: { tags: ["research"] },
    created: ago(25),
    updated: ago(13),
  }),
  review: addTask(pr.id, {
    subject: "Review src/delivery/retry.ts for edge cases",
    description: "Retry storms, unbounded delays, retries on non-retryable status codes.",
    owner: "reviewer",
    status: "in_progress",
    activeForm: "Reviewing retry.ts for edge cases",
    metadata: { progress: 0.45, priority: "high", tags: ["review"] },
    created: ago(25),
    updated: ago(14),
  }),
  tests: addTask(pr.id, {
    subject: "Run the delivery test suite on the PR branch",
    owner: "tester",
    status: "in_progress",
    activeForm: "Waiting for approval to run vitest",
    metadata: { progress: 0.1, tags: ["tests"] },
    created: ago(25),
    updated: ago(22),
  }),
  decide: addTask(pr.id, {
    subject: "Decide: keep the hand-rolled backoff or adopt a library",
    owner: "user",
    metadata: { priority: "high" },
    created: ago(12, 40),
  }),
  fixes: addTask(pr.id, {
    subject: "Apply review fixes to retry.ts",
    owner: "agent",
    created: ago(12, 40),
  }),
  post: addTask(pr.id, {
    subject: "Post the review summary on PR #42",
    owner: "agent",
    created: ago(12, 40),
  }),
  docs: addTask(pr.id, {
    subject: "Add a retry section to docs/delivery.md",
    metadata: { priority: "low", tags: ["docs"] },
    created: ago(12, 40),
  }),
};
link(T.decide, T.fixes);
link(T.fixes, T.post);

const PROMPTS = {
  researcher:
    "Compare maintained Node libraries for retry with exponential backoff and jitter. Must support AbortSignal. Report size, API shape and maintenance status, and how each compares to the hand-rolled loop in src/delivery/retry.ts.",
  reviewer:
    "Review src/delivery/retry.ts on branch pr-42. Look for retry storms, unbounded delays, and retries on status codes that will never succeed. Update your task as you go.",
  tester: "Run the delivery test suite on branch pr-42 and summarize any failures with file and line.",
};

// Main session transcript.
append(
  pr.id,
  "user",
  [
    text(
      "Can you review PR #42? It adds retry with exponential backoff to webhook delivery. Check the retry logic, see whether a library beats the hand-rolled backoff, and run the delivery tests. Flag anything risky before I merge.",
    ),
  ],
  ago(26),
);
const checkout = use("exec", { command: "gh pr checkout 42 && git diff --stat main...HEAD" });
append(pr.id, "assistant", [text("Pulling the PR down first so every subagent works from the same tree."), checkout], ago(25, 50));
approvals.push({
  id: uuid(),
  sessionId: pr.id,
  toolCallId: checkout.id,
  toolName: "exec",
  input: checkout.input,
  tags: ["exec", "network"],
  status: "approved",
  decision: "approve",
  reason: null,
  decidedBy: "dashboard",
  decidedAt: ago(25, 41),
  createdAt: ago(25, 49),
});
append(
  pr.id,
  "tool",
  [
    result(
      checkout,
      "Switched to branch 'pr-42'\n" +
        " src/delivery/retry.ts      | 112 ++++++++++++\n" +
        " src/delivery/webhook.ts    |  41 ++--\n" +
        " src/delivery/retry.spec.ts |  58 ++++++\n" +
        " docs/delivery.md           |   6 +-\n" +
        " 4 files changed, 186 insertions(+), 31 deletions(-)",
    ),
  ],
  ago(25, 30),
);
const creates = [T.research, T.review, T.tests].map((t) => use("create_task", { subject: t.subject }));
append(
  pr.id,
  "assistant",
  [text("The change is contained to `src/delivery`. Putting the work on the shared task list so the subagents can claim it."), ...creates],
  ago(25),
);
append(
  pr.id,
  "tool",
  creates.map((u, i) => result(u, `created task ${[T.research, T.review, T.tests][i].id}`)),
  ago(24, 58),
);
const children = [researcher, reviewer, tester];
const spawns = children.map((s) => use("spawn_subagent", { subagent: s.subagentDefId, prompt: PROMPTS[s.subagentDefId] }));
append(
  pr.id,
  "assistant",
  [text("Fanning out. Each subagent runs on its own model and budget, and all three share the task list."), ...spawns],
  ago(24, 30),
);
append(
  pr.id,
  "tool",
  spawns.map((u, i) => {
    const d = defByName.get(children[i].subagentDefId);
    return result(
      u,
      JSON.stringify({ sessionId: children[i].id, subagent: d.name, model: d.model, status: "running", limits: d.limits }),
    );
  }),
  ago(24, 28),
);
append(
  pr.id,
  "assistant",
  [
    text(
      "**researcher** is done. Short version:\n\n" +
        "| option | dependencies | notes |\n" +
        "|---|---|---|\n" +
        "| keep the hand-rolled loop | none | no cap on the delay, retries 4xx responses |\n" +
        "| `p-retry` | 1 | AbortSignal, `shouldRetry`, `maxTimeout`, widely used |\n" +
        "| `exponential-backoff` | none | works, but per-call overrides are awkward |\n\n" +
        "**reviewer** is partway through `retry.ts` and has already flagged that 4xx responses are retried. " +
        "**tester** is waiting on your approval to run the suite.\n\n" +
        "One decision I need from you before the fixes go in:",
    ),
  ],
  ago(12, 40),
);

// The open question. Two to four options is the protocol's rule, and the
// dashboard always adds its own "Other…" for a free-form answer.
const backoffQuestion = {
  id: uuid(),
  sessionId: pr.id,
  askedBy: toolUseId(),
  askedAt: ago(12, 30),
  answeredAt: null,
  timedOutAt: null,
  status: "pending",
  input: {
    questions: [
      {
        header: "Backoff",
        question: "The PR hand-rolls exponential backoff. Keep it, or switch to a library before merging?",
        options: [
          { label: "Switch to p-retry", description: "Smallest diff that also fixes the 4xx retries" },
          { label: "Keep the hand-rolled loop", description: "Fix the 4xx check and cap the delay in this PR" },
          { label: "Use exponential-backoff", description: "No dependencies, more options to pass around" },
          { label: "Merge as is", description: "Track the fixes in a follow-up issue" },
        ],
        multiSelect: false,
      },
    ],
    allowCustom: true,
  },
  answers: null,
};
questions.push(backoffQuestion);

// researcher: finished.
append(researcher.id, "system", [text(budgetLine(defByName.get("researcher")))], ago(24, 28));
append(researcher.id, "user", [text(PROMPTS.researcher)], ago(24, 28));
const search = use("web_search", { query: "node retry exponential backoff jitter AbortSignal library" });
append(researcher.id, "assistant", [search], ago(24, 10));
append(
  researcher.id,
  "tool",
  [
    result(
      search,
      "1. p-retry: retry a promise-returning or async function (npm)\n" +
        "2. exponential-backoff: retry a function with exponential delay (npm)\n" +
        "3. async-retry: retrying made simple, easy and async (npm)",
    ),
  ],
  ago(24, 5),
);
const fetchDocs = use("web_fetch", { url: "https://www.npmjs.com/package/p-retry" });
append(researcher.id, "assistant", [fetchDocs], ago(23, 30));
append(
  researcher.id,
  "tool",
  [
    result(
      fetchDocs,
      "p-retry: retries a promise-returning function. Options: retries, factor, minTimeout, maxTimeout, randomize, signal, shouldRetry, onFailedAttempt.",
    ),
  ],
  ago(23, 20),
);
append(
  researcher.id,
  "assistant",
  [
    text(
      "Recommendation: **p-retry**.\n\n" +
        "- `shouldRetry` makes it one line to skip 4xx responses, which the PR currently retries.\n" +
        "- `maxTimeout` caps the delay; the PR's loop has no cap.\n" +
        "- Takes an `AbortSignal`, so a shutdown can cancel pending retries.\n\n" +
        "`exponential-backoff` also works and has no dependencies, but its options are fixed per call site. `async-retry` has not had a release in a long time.",
    ),
  ],
  ago(13, 5),
);

// reviewer: running. The storyline below continues it live.
append(reviewer.id, "system", [text(budgetLine(defByName.get("reviewer")))], ago(24, 27));
append(reviewer.id, "user", [text(PROMPTS.reviewer)], ago(24, 27));
const readRetry = use("read", { path: "src/delivery/retry.ts" });
append(reviewer.id, "assistant", [readRetry], ago(23, 40));
append(
  reviewer.id,
  "tool",
  [
    result(
      readRetry,
      "export async function deliverWithRetry(hook: Webhook, body: string): Promise<void> {\n" +
        "  let attempt = 0;\n" +
        "  for (;;) {\n" +
        "    const res = await post(hook.url, body);\n" +
        "    if (res.ok) return;\n" +
        "    attempt += 1;\n" +
        "    if (attempt > hook.maxAttempts) throw new DeliveryError(res.status);\n" +
        "    const delay = 2 ** attempt * 250 + Math.random() * 1000;\n" +
        "    await sleep(delay);\n" +
        "  }\n" +
        "}",
    ),
  ],
  ago(23, 38),
);
append(
  reviewer.id,
  "assistant",
  [
    text(
      "First finding: every non-2xx response is retried, including 400 and 404. Those will never succeed, so one bad URL burns the full retry budget. Retry only 408, 429 and 5xx.",
    ),
  ],
  ago(14),
);

// tester: blocked on an approval for its shell command.
append(tester.id, "system", [text(budgetLine(defByName.get("tester")))], ago(24, 26));
append(tester.id, "user", [text(PROMPTS.tester)], ago(24, 26));
const runTests = use("exec", { command: "pnpm vitest run src/delivery --reporter=dot" });
append(tester.id, "assistant", [text("Running the suite needs a shell, so this waits on an approval."), runTests], ago(22, 10));
const testApproval = {
  id: uuid(),
  sessionId: tester.id,
  toolCallId: runTests.id,
  toolName: "exec",
  input: runTests.input,
  tags: ["exec"],
  status: "pending",
  decision: null,
  reason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: ago(22, 5),
};
approvals.push(testApproval);

// ---------------------------------------------------------------------------
// Older sessions, so the lists and search have some history
// ---------------------------------------------------------------------------

const flaky = addSession({
  title: "Fix flaky test in scheduler.spec.ts",
  created: ago(130),
  updated: ago(118),
  tokensIn: 22_800,
  tokensOut: 3_100,
});
append(flaky.id, "user", [text("scheduler.spec.ts fails about one run in ten on CI. Can you find out why?")], ago(130));
const readSpec = use("read", { path: "src/scheduler/scheduler.spec.ts" });
append(flaky.id, "assistant", [readSpec], ago(129, 40));
append(
  flaky.id,
  "tool",
  [
    result(
      readSpec,
      "it('fires on the next minute boundary', async () => {\n" +
        "  const s = new Scheduler();\n" +
        "  s.add('* * * * *', job);\n" +
        "  await sleep(61_000 - (Date.now() % 60_000));\n" +
        "  expect(job).toHaveBeenCalledTimes(1);\n" +
        "});",
    ),
  ],
  ago(129, 35),
);
const repeat = use("exec", { command: "pnpm vitest run src/scheduler --repeat 20" });
append(flaky.id, "assistant", [repeat], ago(128));
append(flaky.id, "tool", [result(repeat, "18 passed, 2 failed: fires on the next minute boundary (timeout)")], ago(126));
append(
  flaky.id,
  "assistant",
  [
    text(
      "Root cause: the test waits on the real clock. On a slow runner the wait crosses a second minute boundary and the job fires twice, or the wait overshoots the test timeout.\n\n" +
        "I switched it to `vi.useFakeTimers()` and advance time explicitly. 50 repeated runs pass locally. Opening the PR is on your list.",
    ),
  ],
  ago(118),
);
addTask(flaky.id, { subject: "Reproduce the flaky scheduler test locally", owner: "agent", status: "completed", created: ago(129), updated: ago(126) });
addTask(flaky.id, { subject: "Replace wall-clock waits with fake timers", owner: "agent", status: "completed", created: ago(126), updated: ago(119) });
addTask(flaky.id, { subject: "Open a PR with the scheduler test fix", owner: "user", created: ago(118) });

const releaseNotes = addSession({
  title: "Draft release notes for v0.9",
  platform: "discord",
  remoteId: "demo-guild/#releases",
  created: ago(310),
  updated: ago(300),
  tokensIn: 15_200,
  tokensOut: 4_400,
});
append(releaseNotes.id, "user", [text("Draft release notes for v0.9 from the PRs merged since v0.8.")], ago(310));
const versionQuestion = {
  id: uuid(),
  sessionId: releaseNotes.id,
  askedBy: toolUseId(),
  askedAt: ago(309, 30),
  answeredAt: ago(305),
  timedOutAt: null,
  status: "answered",
  input: {
    questions: [
      {
        header: "Version",
        question: "Should these notes go out as v0.9.0 or as a v0.9.0-rc.1 pre-release?",
        options: [
          { label: "v0.9.0", description: "Final release" },
          { label: "v0.9.0-rc.1", description: "Pre-release for a week of testing" },
        ],
        multiSelect: false,
      },
    ],
    allowCustom: true,
  },
  answers: { "Should these notes go out as v0.9.0 or as a v0.9.0-rc.1 pre-release?": "v0.9.0" },
};
questions.push(versionQuestion);
const gitLog = use("exec", { command: "git log v0.8.0..HEAD --merges --oneline" });
append(releaseNotes.id, "assistant", [gitLog], ago(304));
append(
  releaseNotes.id,
  "tool",
  [
    result(
      gitLog,
      "a1b2c3d Merge pull request #38 from demo/routines-webhooks\n" +
        "9f8e7d6 Merge pull request #39 from demo/fts-search\n" +
        "5c4b3a2 Merge pull request #40 from demo/dashboard-logs\n" +
        "1d2e3f4 Merge pull request #41 from demo/approval-rules",
    ),
  ],
  ago(303, 50),
);
append(
  releaseNotes.id,
  "assistant",
  [
    text(
      "## v0.9.0\n\n### Added\n" +
        "- Routines can be triggered by a webhook (#38)\n" +
        "- Full-text search across session transcripts (#39)\n" +
        "- Live log viewer in the dashboard (#40)\n" +
        "- Approval rules scoped to a session or a subagent (#41)\n\n" +
        "Posted the draft in #releases for review.",
    ),
  ],
  ago(300),
);

const audit = addSession({
  title: "Weekly dependency audit",
  model: M.haiku,
  status: "ended",
  created: ago(26 * 60),
  updated: ago(26 * 60 - 3),
  tokensIn: 9_800,
  tokensOut: 1_250,
});
const AUDIT_PROMPT = "Run `pnpm outdated -r` and list anything with a security advisory or a major version behind.";
append(audit.id, "user", [text(AUDIT_PROMPT)], ago(26 * 60));
const outdated = use("exec", { command: "pnpm outdated -r --format list" });
append(audit.id, "assistant", [outdated], ago(26 * 60 - 1));
append(
  audit.id,
  "tool",
  [result(outdated, "example-http-client 2.3.1 -> 2.3.4 (advisory: moderate)\nexample-bundler 5.4.0 -> 6.0.2\nexample-schema 3.9.0 -> 4.1.0")],
  ago(26 * 60 - 2),
);
append(
  audit.id,
  "assistant",
  [
    text(
      "Three packages need attention:\n\n" +
        "| package | current | latest | why |\n|---|---|---|---|\n" +
        "| `example-http-client` | 2.3.1 | 2.3.4 | moderate advisory, patch release |\n" +
        "| `example-bundler` | 5.4.0 | 6.0.2 | one major behind |\n" +
        "| `example-schema` | 3.9.0 | 4.1.0 | one major behind, breaking API |\n\n" +
        "No critical advisories. The patch upgrade is safe to take now.",
    ),
  ],
  ago(26 * 60 - 3),
);

const searchCompare = addSession({
  title: "Compare SQLite FTS5 and Meilisearch for transcript search",
  model: M.opus,
  status: "ended",
  created: ago(3 * 24 * 60),
  updated: ago(3 * 24 * 60 - 6),
  tokensIn: 26_500,
  tokensOut: 5_900,
});
append(
  searchCompare.id,
  "user",
  [text("We need search across session transcripts. Compare SQLite FTS5 with running Meilisearch next to the gateway.")],
  ago(3 * 24 * 60),
);
append(
  searchCompare.id,
  "assistant",
  [
    text(
      "| | SQLite FTS5 | Meilisearch |\n|---|---|---|\n" +
        "| moving parts | none, same database file | a second service to run and back up |\n" +
        "| ranking | BM25 | typo-tolerant, tunable |\n" +
        "| consistency | same transaction as the message write | eventually consistent |\n" +
        "| fit for one gateway per squad | good | heavier than the problem |\n\n" +
        "Recommendation: **FTS5**. Transcripts already live in SQLite, so search stays in the same transaction and there is nothing new to operate. Revisit if typo tolerance becomes a real complaint.",
    ),
  ],
  ago(3 * 24 * 60 - 6),
);

// ---------------------------------------------------------------------------
// Routines, plugins, channels, apps, peers, pairings, logs
// ---------------------------------------------------------------------------

function nextDaily(hour, minute) {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function nextWeekly(dow, hour, minute) {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  const add = (dow - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + add);
  if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

/** Next fire for the cron shapes routines here use ("m h * * *", "m h * * d"); null for anything else. */
function nextCron(expr) {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|\d)$/.exec(expr.trim());
  if (!m) return null;
  return m[3] === "*" ? nextDaily(Number(m[2]), Number(m[1])) : nextWeekly(Number(m[3]), Number(m[2]), Number(m[1]));
}

const routines = new Map();
/** routineId -> RoutineRunLog[], newest first. */
const routineRuns = new Map();

function addRoutine(fields) {
  const r = {
    id: uuid(),
    enabled: true,
    session: { kind: "new" },
    execution: {},
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    lastError: null,
    consecutiveErrors: 0,
    ...fields,
  };
  syncLegacy(r);
  routines.set(r.id, r);
  routineRuns.set(r.id, []);
  return r;
}

/** Keep the legacy mirror fields (cron, prompt, model) in step with the structured ones, as the gateway does on read. */
function syncLegacy(r) {
  r.cron = r.schedule.kind === "cron" ? r.schedule.expr : "";
  r.prompt = r.payload.kind === "prompt" ? r.payload.messages.map((m) => m.text).join("\n") : "";
  r.model = r.execution?.model ?? null;
  if (r.schedule.kind === "cron") r.nextRunAt = r.enabled ? nextCron(r.schedule.expr) : null;
  if (r.schedule.kind === "once") r.nextRunAt = r.enabled ? r.schedule.at : null;
  if (r.schedule.kind === "webhook") r.nextRunAt = null;
}

const weeklyAudit = addRoutine({
  name: "Weekly dependency audit",
  schedule: { kind: "cron", expr: "0 9 * * 1", tz: "UTC" },
  payload: { kind: "prompt", messages: [{ role: "user", text: AUDIT_PROMPT }] },
  execution: { model: M.haiku },
  delivery: { kind: "dashboard" },
  lastRunAt: ago(26 * 60),
  lastStatus: "ok",
});
routineRuns.get(weeklyAudit.id).push(
  { ts: ago(26 * 60 - 3), status: "ok", durationMs: 41_200, sessionId: audit.id, payloadKind: "prompt", output: "3 packages need attention, no critical advisories", delivery: { kind: "dashboard", ok: true }, tokens: { in: 9_800, out: 1_250 } },
  { ts: ago(8 * 24 * 60 - 26 * 60), status: "ok", durationMs: 38_900, payloadKind: "prompt", output: "1 package needs attention", delivery: { kind: "dashboard", ok: true }, tokens: { in: 8_900, out: 900 } },
  { ts: ago(15 * 24 * 60 - 26 * 60), status: "ok", durationMs: 44_100, payloadKind: "prompt", output: "Nothing outdated with an advisory", delivery: { kind: "dashboard", ok: true }, tokens: { in: 9_100, out: 700 } },
);

// Fires for real every minute (see the ambient loop) so the Cron view and the
// Overview activity feed keep moving after the storyline is over.
const ciWatch = addRoutine({
  name: "Watch CI on main",
  schedule: { kind: "interval", everyMs: 60_000, anchor: new Date(STARTED).toISOString() },
  payload: {
    kind: "scriptThenPrompt",
    command: "gh",
    args: ["run", "list", "--branch", "main", "--limit", "5", "--json", "conclusion,name"],
    prompt: { messages: [{ role: "user", text: "If the latest run failed, summarize the failing job and add a task." }] },
  },
  session: { kind: "isolated" },
  execution: { model: M.mini },
  delivery: { kind: "silent" },
  lastRunAt: ago(0, 20),
  nextRunAt: new Date(T0 + 40_000).toISOString(),
  lastStatus: "ok",
});
for (let i = 0; i < 6; i++) {
  routineRuns.get(ciWatch.id).push({
    ts: ago(i, 20),
    status: i === 4 ? "skipped" : "ok",
    durationMs: 900 + ((i * 337) % 700),
    payloadKind: "scriptThenPrompt",
    output: i === 4 ? "previous run still in flight" : "latest 5 runs green",
    delivery: { kind: "silent", ok: true },
    ...(i === 4 ? {} : { tokens: { in: 610, out: 24 } }),
  });
}

const nightlySweep = addRoutine({
  name: "Nightly flaky-test sweep",
  enabled: false,
  schedule: { kind: "cron", expr: "30 2 * * *", tz: "UTC" },
  payload: { kind: "prompt", messages: [{ role: "user", text: "Run the full test suite five times and list every test that failed at least once." }] },
  execution: { model: M.sonnet, timeoutSec: 900 },
  failure: { alertChannel: "discord", cooldownSec: 3600 },
  delivery: { kind: "discord", channelId: "100000000000000001" },
  lastRunAt: ago(20 * 60),
  lastStatus: "error",
  lastError: "run exceeded timeoutSec (900s)",
  consecutiveErrors: 2,
});
routineRuns.get(nightlySweep.id).push(
  { ts: ago(20 * 60 - 15), status: "error", durationMs: 900_000, payloadKind: "prompt", error: "run exceeded timeoutSec (900s)", delivery: { kind: "discord", ok: true } },
  { ts: ago(44 * 60 - 15), status: "error", durationMs: 900_000, payloadKind: "prompt", error: "run exceeded timeoutSec (900s)", delivery: { kind: "discord", ok: true } },
  { ts: ago(68 * 60 - 12), status: "ok", durationMs: 702_400, payloadKind: "prompt", output: "1 flaky test: scheduler.spec.ts > fires on the next minute boundary", delivery: { kind: "discord", ok: true }, tokens: { in: 31_000, out: 1_900 } },
);

/** The plugins the gateway can install, with the describe() details the configure modal reads. */
const catalog = [
  {
    id: "channel-discord",
    name: "Discord",
    description: "First-party Discord channel: DMs, slash commands, threads.",
    kinds: ["channel"],
    source: "../channel-discord/dist/plugin.js",
    requires: [],
    version: "0.4.2",
    fields: [
      { name: "dm_policy", kind: "enum", required: false, description: "Who may DM the bot", default: "allow_list", options: ["allow_list", "open", "closed"] },
    ],
    defaultConfig: { bot_token_env: "DISCORD_BOT_TOKEN", dm_policy: "allow_list" },
    needsAuthToken: true,
    secrets: [{ envVar: "DISCORD_BOT_TOKEN", label: "Discord bot token", required: true, hint: "From the developer portal, Bot tab.", set: true }],
  },
  {
    id: "@squad/plugin-google-auth",
    name: "Google OAuth",
    description: "Shared Google OAuth and token storage for Calendar, Gmail and Drive.",
    kinds: ["tool"],
    source: "../plugin-google-auth/dist/plugin.js",
    requires: [],
    version: "0.2.0",
    fields: [],
    defaultConfig: {},
    needsAuthToken: false,
    secrets: [
      { envVar: "GOOGLE_OAUTH_CLIENT_ID", label: "OAuth client id", required: true, set: true },
      { envVar: "GOOGLE_OAUTH_CLIENT_SECRET", label: "OAuth client secret", required: true, set: true },
    ],
  },
  {
    id: "@squad/plugin-gmail",
    name: "Gmail",
    description: "Gmail tools: search, read, send, label.",
    kinds: ["tool"],
    source: "../plugin-gmail/dist/plugin.js",
    requires: ["@squad/plugin-google-auth"],
    version: "0.2.0",
    fields: [{ name: "send_enabled", kind: "boolean", required: false, description: "Let the agent send mail (approvals still apply)", default: false }],
    defaultConfig: { send_enabled: false },
    needsAuthToken: false,
    secrets: [],
  },
  {
    id: "@squad/plugin-google-calendar",
    name: "Google Calendar",
    description: "Calendar tools: list, create, update, delete, RSVP.",
    kinds: ["tool"],
    source: "../plugin-google-calendar/dist/plugin.js",
    requires: ["@squad/plugin-google-auth"],
    version: "0.2.0",
    fields: [{ name: "calendar_id", kind: "string", required: false, description: "Calendar to read and write", default: "primary" }],
    defaultConfig: { calendar_id: "primary" },
    needsAuthToken: false,
    secrets: [],
  },
  {
    id: "@squad/plugin-google-drive",
    name: "Google Drive",
    description: "Drive tools: search, list, read.",
    kinds: ["tool"],
    source: "../plugin-google-drive/dist/plugin.js",
    requires: ["@squad/plugin-google-auth"],
    version: "0.2.0",
    fields: [],
    defaultConfig: {},
    needsAuthToken: false,
    secrets: [],
  },
];
const catalogById = new Map(catalog.map((c) => [c.id, c]));

function pluginFromCatalog(c, config = c.defaultConfig, installedAt = now()) {
  return {
    id: c.id,
    name: c.name,
    version: c.version,
    kinds: c.kinds,
    enabled: true,
    config,
    source: c.source,
    installedAt,
    uiContributions: [],
    status: "loaded",
  };
}

/** id -> PluginRecord. Three loaded from the catalog, plus one local plugin that failed to load. */
const plugins = new Map(
  [
    pluginFromCatalog(catalogById.get("channel-discord"), { dm_policy: "allow_list" }, ago(9 * 24 * 60)),
    pluginFromCatalog(catalogById.get("@squad/plugin-google-auth"), {}, ago(6 * 24 * 60)),
    pluginFromCatalog(catalogById.get("@squad/plugin-google-calendar"), { calendar_id: "primary" }, ago(6 * 24 * 60)),
    {
      id: "local-weather",
      name: "Weather",
      version: "0.1.0",
      kinds: ["tool"],
      enabled: true,
      source: "./plugins/weather/dist/plugin.js",
      installedAt: ago(2 * 24 * 60),
      uiContributions: [],
      status: "failed",
      error: {
        code: "missing_config",
        message: "WEATHER_API_KEY is not set",
        field: "apiKey",
        envVar: "WEATHER_API_KEY",
        hint: "Set the key on the gateway host, then reload the plugin.",
      },
    },
  ].map((p) => [p.id, p]),
);

const channels = [
  {
    id: "discord",
    kind: "discord",
    label: "demo-guild · #squad",
    connected: true,
    capabilities: {
      supportsPreview: true,
      supportsMultiSelect: true,
      supportsFreeText: true,
      maxOptions: 4,
      supportsImages: true,
      supportsFileUploads: true,
      supportsTaskList: true,
      supportsApprovals: true,
    },
  },
];

const apps = [
  {
    name: "retry-viz",
    title: "Retry timeline",
    description: "Delay before each delivery attempt, as the PR computes it",
    host: "127.0.0.1",
    port: 4310,
    scope: "session",
    sessionId: pr.id,
    registeredAt: T0 - 15 * 60_000,
    health: "healthy",
    info: null,
  },
];

const peers = [
  { name: SQUAD, port: PORT, url: `http://${HOST}:${PORT}`, status: "healthy", build: "mock", startedAt: new Date(STARTED).toISOString() },
  { name: "sandbox", port: PORT + 1, url: `http://${HOST}:${PORT + 1}`, status: "stopped", build: null, startedAt: null },
];

/** code -> PairingView. The token for a pending pairing is kept apart, as it is never part of the view. */
const pairings = new Map(
  [
    {
      code: "K7QMX-W2PDH",
      label: "Chrome on macOS",
      scopes: ["*"],
      status: "claimed",
      createdAt: ago(2 * 24 * 60),
      expiresAt: ago(2 * 24 * 60 - 10),
      approvedAt: ago(2 * 24 * 60 - 1),
      approvedBy: "cli",
      claimedAt: ago(2 * 24 * 60 - 1),
      persistent: true,
    },
    {
      code: "P2D9T-RNV4C",
      label: "Safari on iOS",
      scopes: ["*"],
      status: "expired",
      createdAt: ago(5 * 60),
      expiresAt: ago(5 * 60 - 10),
      approvedAt: null,
      approvedBy: null,
      claimedAt: null,
      persistent: false,
    },
  ].map((p) => [p.code, p]),
);
const pairingTokens = new Map();

const TOOL_CATALOG = [
  { name: "read", description: "Read a file from the workspace", tags: ["filesystem", "read"] },
  { name: "write", description: "Write a file in the workspace", tags: ["filesystem", "write"] },
  { name: "edit", description: "Edit a file in place", tags: ["filesystem", "write"] },
  { name: "grep", description: "Search file contents", tags: ["filesystem", "read"] },
  { name: "glob", description: "List files by pattern", tags: ["filesystem", "read"] },
  { name: "exec", description: "Run a shell command", tags: ["exec", "shell"] },
  { name: "web_search", description: "Search the web", tags: ["network"] },
  { name: "web_fetch", description: "Fetch a URL", tags: ["network"] },
  { name: "spawn_subagent", description: "Delegate work to a subagent", tags: ["subagents"] },
  { name: "ask_user", description: "Ask the user a multiple-choice question", tags: ["questions"] },
  { name: "create_task", description: "Add a task to the shared list", tags: ["tasks"] },
  { name: "update_task", description: "Change a task's status, owner or dependencies", tags: ["tasks"] },
  { name: "list_tasks", description: "List tasks in the session tree", tags: ["tasks"] },
];

// Logs: a ring buffer the Logs view tails, plus a live entry per event.
const LEVEL_RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LOG_LIMIT = 500;
const logs = [];
let logSeq = 0;

function log(level, source, msg, bindings = {}, time = now()) {
  const entry = { id: ++logSeq, time, level, source, msg, bindings };
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  publish("logs.entry", { entry });
  return entry;
}

const startedIso = new Date(STARTED).toISOString();
const seedLogs = [
  [startedIso, "info", "gateway", "gateway listening", { host: HOST, port: PORT, squad: SQUAD }],
  [new Date(STARTED + 1500).toISOString(), "info", "plugins", "plugin loaded", { plugin: "channel-discord" }],
  [new Date(STARTED + 1600).toISOString(), "info", "plugins", "plugin loaded", { plugin: "@squad/plugin-google-calendar" }],
  [new Date(STARTED + 1800).toISOString(), "error", "plugins", "plugin load failed", { plugin: "local-weather", code: "missing_config", envVar: "WEATHER_API_KEY" }],
  [new Date(STARTED + 2600).toISOString(), "info", "channel-discord", "connected", { guild: "demo-guild" }],
  [ago(130), "info", "runner", "run started", { sessionId: flaky.id, model: M.sonnet }],
  [ago(126), "warn", "llm", "provider returned 429, rotating key", { provider: "anthropic", retryInMs: 1200 }],
  [ago(118), "info", "runner", "run finished", { sessionId: flaky.id, tokensOut: 3100 }],
  [ago(60), "error", "routines", "routine run failed", { routine: nightlySweep.name, error: "run exceeded timeoutSec (900s)" }],
  [ago(26), "info", "runner", "run started", { sessionId: pr.id, model: M.sonnet }],
  [ago(25, 49), "info", "approvals", "approval requested", { tool: "exec", tags: ["exec", "network"] }],
  [ago(25, 41), "info", "approvals", "approval decided", { tool: "exec", decision: "approve" }],
  [ago(24, 28), "info", "subagents", "subagent spawned", { subagent: "researcher", model: M.haiku }],
  [ago(24, 27), "info", "subagents", "subagent spawned", { subagent: "reviewer", model: M.opus }],
  [ago(24, 26), "info", "subagents", "subagent spawned", { subagent: "tester", model: M.gpt }],
  [ago(22, 5), "info", "approvals", "approval requested", { tool: "exec", tags: ["exec"], subagent: "tester" }],
  [ago(13), "info", "subagents", "subagent completed", { subagent: "researcher", tokensIn: 18_400, tokensOut: 2_150 }],
  [ago(12, 30), "info", "questions", "question asked", { sessionId: pr.id, header: "Backoff" }],
  [ago(1), "debug", "llm", "cache hit", { sessionId: reviewer.id, ratio: 0.81 }],
];
for (const [time, level, source, msg, bindings] of seedLogs) log(level, source, msg, bindings, time);

// ---------------------------------------------------------------------------
// Event hub
// ---------------------------------------------------------------------------

/**
 * The gateway's rule: a topic matches a subscription exactly, or by pattern
 * where `*` is any run of characters other than `/` (the scope separator), so
 * "chat.*\/*" covers "chat.text_delta/<sessionId>" and "session.*" does not.
 */
function topicMatches(pattern, topic) {
  if (pattern === topic) return true;
  if (!pattern.includes("*")) return false;
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\*]/g, "\\$&").replace(/\\\*/g, "[^/]+") + "$");
    patternCache.set(pattern, re);
  }
  return re.test(topic);
}

function publish(topic, data) {
  if (clients.size === 0) return;
  const frame = JSON.stringify({ type: "event", topic, data });
  for (const c of clients) {
    for (const p of c.topics) {
      if (topicMatches(p, topic)) {
        c.conn.sendText(frame);
        break;
      }
    }
  }
}

function touch(session) {
  session.updatedAt = now();
  publish("session.updated", { session });
}

function setStatus(session, status) {
  session.status = status;
  touch(session);
}

function updateTask(task, patch) {
  for (const k of ["subject", "description", "owner", "status"]) if (patch[k] !== undefined) task[k] = patch[k];
  if (patch.activeForm !== undefined) {
    if (patch.activeForm === null) delete task.activeForm;
    else task.activeForm = patch.activeForm;
  }
  if (patch.metadata) task.metadata = { ...(task.metadata ?? {}), ...patch.metadata };
  const edges = (list, add = [], remove = []) => [...new Set([...list, ...add])].filter((id) => !remove.includes(id));
  task.blocks = edges(task.blocks, patch.addBlocks, patch.removeBlocks);
  task.blockedBy = edges(task.blockedBy, patch.addBlockedBy, patch.removeBlockedBy);
  task.updatedAt = now();
  publish(`tasks.${task.status === "deleted" ? "deleted" : "updated"}/${task.taskListId}`, { task });
  return task;
}

// ---------------------------------------------------------------------------
// Scripted turns
// ---------------------------------------------------------------------------

/** sessionId -> the run in flight, so chat.cancel has something to stop. */
const runs = new Map();
/** sessionId -> the tail of that session's turn queue. One turn at a time per session, like the gateway. */
const chains = new Map();

/**
 * Play one agent turn the way runs.ts emits it: each tool call and its result
 * as they happen, the reply as text deltas, then only the final assistant
 * message broadcast. The intermediate tool_use and tool_result messages are
 * stored, not broadcast, so a reload shows what the live view showed.
 *
 * `tools[].existing` resumes a tool_use already in the transcript (an
 * approval that was waiting on it) instead of emitting a new call.
 */
async function playTurn(sessionId, { tools = [], reply, status, done, runId }) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const run = { id: runId ?? uuid(), cancelled: false };
  runs.set(sessionId, run);
  const resting = session.status;
  const sub = session.parentSessionId !== null;
  const emit = (kind, payload) => {
    publish(`chat.${kind}/${sessionId}`, { sessionId, runId: run.id, ...payload });
    if (sub) publish(`subagents.${kind}/${sessionId}`, { sessionId, ...payload });
  };
  setStatus(session, "running");
  try {
    for (const step of tools) {
      await sleep(500);
      if (run.cancelled) break;
      let u = step.existing;
      if (!u) {
        u = use(step.name, step.input);
        append(sessionId, "assistant", [u]);
        emit("tool_call", { toolCallId: u.id, name: u.name, input: u.input });
        await sleep(step.ms ?? 900);
        if (run.cancelled) break;
      }
      append(sessionId, "tool", [result(u, step.result, step.isError)]);
      emit("tool_result", { toolCallId: u.id, result: step.result, isError: Boolean(step.isError) });
      step.then?.();
    }
    let said = "";
    if (!run.cancelled) {
      await sleep(400);
      for (const chunk of reply.match(/\S+\s*|\s+/g) ?? []) {
        if (run.cancelled) break;
        said += chunk;
        emit("text_delta", { delta: chunk });
        await sleep(35);
      }
    }
    const finalText = run.cancelled ? `${said.trimEnd()}${said ? "\n\n" : ""}_Stopped from the dashboard._` : reply;
    const final = append(sessionId, "assistant", [text(finalText)]);
    publish(`chat.assistant_message/${sessionId}`, { sessionId, message: final, runId: run.id });
    session.tokensIn += 1500 + Math.floor(Math.random() * 2500);
    session.tokensOut += Math.ceil(finalText.length / 4) + 60;
  } finally {
    runs.delete(sessionId);
    setStatus(session, run.cancelled ? (resting === "running" ? "idle" : resting) : (status ?? resting));
  }
  if (!run.cancelled) done?.();
}

function enqueueTurn(sessionId, script) {
  const queued = chains.has(sessionId);
  const next = (chains.get(sessionId) ?? Promise.resolve())
    .then(() => playTurn(sessionId, script))
    .catch((err) => log("error", "runner", "scripted turn failed", { sessionId, error: String(err) }))
    .finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    });
  chains.set(sessionId, next);
  return { queued, done: next };
}

const backoffFollowUp = (pick) => {
  const lib = /p-retry/i.test(pick) ? "p-retry" : /exponential-backoff/i.test(pick) ? "exponential-backoff" : null;
  const asIs = /as is/i.test(pick);
  const plan = lib
    ? `Swap the loop for \`${lib}\`, retry only 408/429/5xx, cap the delay at 10 s.`
    : asIs
      ? "Merge as is; file a follow-up for the 4xx retries and the delay cap."
      : "Keep the loop, retry only 408/429/5xx, cap the delay at 10 s.";
  return {
    tools: [
      {
        name: "update_task",
        input: { taskId: T.decide.id, status: "completed" },
        result: `updated task ${T.decide.id}`,
        then: () => updateTask(T.decide, { status: "completed" }),
      },
      {
        name: "update_task",
        input: { taskId: T.fixes.id, removeBlockedBy: [T.decide.id], description: plan },
        result: `updated task ${T.fixes.id}`,
        then: () => updateTask(T.fixes, { removeBlockedBy: [T.decide.id], description: plan }),
      },
    ],
    reply:
      `Going with **${pick}**. The fix task is unblocked and says exactly what changes: ${plan}\n\n` +
      "I'll apply it once the reviewer and the tester report back, so their findings land in the same commit.",
  };
};

const TEST_OUTPUT =
  "...........x............\n\n" +
  " FAIL  src/delivery/retry.spec.ts > deliverWithRetry > gives up after maxAttempts\n" +
  "   AssertionError: expected post to be called 8 times, but got 9 times\n" +
  "   > src/delivery/retry.spec.ts:41:27\n\n" +
  " Test Files  1 failed | 3 passed (4)\n" +
  "      Tests  1 failed | 23 passed (24)\n" +
  "   Duration  2.84s";

function finishTester(summary) {
  publish(`subagents.completed/${tester.id}`, {
    sessionId: tester.id,
    result: summary,
    tokensIn: tester.tokensIn,
    tokensOut: tester.tokensOut,
  });
  log("info", "subagents", "subagent completed", { subagent: "tester", tokensIn: tester.tokensIn, tokensOut: tester.tokensOut });
}

function testerAfterApproval(approved) {
  if (!approved) {
    return {
      tools: [{ existing: runTests, result: "denied by user", isError: true }],
      reply: "The test command was denied, so the suite did not run. I left the task open and unowned so it can be picked up again.",
      status: "ended",
      done: () => {
        updateTask(T.tests, { status: "pending", owner: null, activeForm: null, metadata: { progress: 0 } });
        finishTester("tests not run: command denied");
      },
    };
  }
  return {
    tools: [
      {
        existing: runTests,
        result: TEST_OUTPUT,
        then: () => updateTask(T.tests, { activeForm: "Summarizing test failures", metadata: { progress: 0.9 } }),
      },
    ],
    reply:
      "23 of 24 tests pass. The failure is real, not flaky: `gives up after maxAttempts` expects 8 requests and sees 9, " +
      "because the loop checks `attempt > maxAttempts` after incrementing. It should be `>=`. Adding it to the review fixes.",
    status: "ended",
    done: () => {
      updateTask(T.tests, { status: "completed", activeForm: null, metadata: { progress: 1 } });
      updateTask(T.fixes, { description: `${T.fixes.description ? T.fixes.description + " " : ""}Also fix the off-by-one in maxAttempts.` });
      finishTester("1 of 24 failed: off-by-one in maxAttempts");
    },
  };
}

function cannedReply(session, content) {
  const said = typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const quote = said.length > 80 ? `${said.slice(0, 77)}…` : said;
  const open = (taskLists.get(rootOf(session.id)) ?? []).filter((t) => t.status === "pending" || t.status === "in_progress").length;
  return {
    tools: [{ name: "list_tasks", input: { sessionId: session.id }, result: `${open} open task${open === 1 ? "" : "s"} in this session tree` }],
    reply:
      `Got it: "${quote}"\n\n` +
      "This is the dashboard's demo gateway, so no model is attached and this reply is canned. " +
      "Against a real gateway the agent would pick your message up between turns and adjust the plan.",
  };
}

// ---------------------------------------------------------------------------
// The live storyline: the reviewer finishes its pass while you watch
// ---------------------------------------------------------------------------

const REVIEW_BEATS = [
  {
    tools: [
      {
        name: "grep",
        input: { pattern: "maxAttempts", path: "src/delivery" },
        result:
          "src/delivery/retry.ts:7:    if (attempt > hook.maxAttempts) throw new DeliveryError(res.status);\n" +
          "src/delivery/webhook.ts:22:  maxAttempts: config.maxAttempts ?? 8,",
      },
    ],
    reply:
      "Second finding: `maxAttempts` defaults to 8 and the delay doubles from 500 ms, so the last wait is about a minute plus up to 1 s of jitter. " +
      "Worst case is over two minutes per delivery, holding a worker the whole time. Suggest a `maxDelay` cap of 10 s.",
    progress: 0.65,
  },
  {
    tools: [
      {
        name: "read",
        input: { path: "src/delivery/retry.spec.ts" },
        result:
          "describe('deliverWithRetry', () => {\n" +
          "  it('retries until success', async () => { ... });\n" +
          "  it('gives up after maxAttempts', async () => { ... });\n" +
          "});",
      },
    ],
    reply:
      "Third finding: the spec has no case for a 4xx response, which is how the first finding got through. " +
      "Adding `it('does not retry a 404')` to the fix list.",
    progress: 0.85,
  },
];

const REVIEW_SUMMARY =
  "Review done. Three findings, in priority order:\n\n" +
  "1. 4xx responses are retried. Retry only 408, 429 and 5xx.\n" +
  "2. The delay has no cap. Add `maxDelay` (10 s).\n" +
  "3. No test covers the 4xx path.\n\n" +
  "None of these argue against a library: `p-retry` covers 1 and 2 with `shouldRetry` and `maxTimeout`.";

let storyStarted = false;

function startStory() {
  if (storyStarted) return;
  storyStarted = true;
  void (async () => {
    await sleep(3000);
    for (const [i, beat] of REVIEW_BEATS.entries()) {
      await enqueueTurn(reviewer.id, {
        ...beat,
        done: () => {
          updateTask(T.review, { metadata: { progress: beat.progress } });
          log("info", "subagents", "subagent step", { subagent: "reviewer", step: i + 2 });
        },
      }).done;
      await sleep(i === 0 ? 8000 : 22_000);
    }
    await enqueueTurn(reviewer.id, {
      tools: [
        {
          name: "update_task",
          input: { taskId: T.review.id, status: "completed" },
          result: `updated task ${T.review.id}`,
          then: () => updateTask(T.review, { status: "completed", activeForm: null, metadata: { progress: 1 } }),
        },
      ],
      reply: REVIEW_SUMMARY,
      status: "ended",
      done: () => {
        publish(`subagents.completed/${reviewer.id}`, {
          sessionId: reviewer.id,
          result: REVIEW_SUMMARY,
          tokensIn: reviewer.tokensIn,
          tokensOut: reviewer.tokensOut,
        });
        log("info", "subagents", "subagent completed", { subagent: "reviewer", tokensIn: reviewer.tokensIn, tokensOut: reviewer.tokensOut });
      },
    }).done;
  })();
}

// ---------------------------------------------------------------------------
// Ambient: a routine firing every minute and a trickle of log lines
// ---------------------------------------------------------------------------

function fireRoutine(r, { manual = false } = {}) {
  let sessionId = null;
  const started = Date.now();
  if (r.session.kind === "new" && r.payload.kind === "prompt") {
    const s = addSession({ title: `${r.name} · ${manual ? "manual run" : "scheduled run"}`, model: r.execution.model ?? primaryModel(), status: "ended" });
    append(s.id, "user", [text(r.payload.messages.map((m) => m.text).join("\n"))]);
    append(s.id, "assistant", [text("Ran it. Nothing changed since the last run.")]);
    publish("session.created", { session: s });
    sessionId = s.id;
  }
  r.lastRunAt = now();
  r.lastStatus = "ok";
  r.lastError = null;
  r.consecutiveErrors = 0;
  if (r.schedule.kind === "interval") r.nextRunAt = new Date(Date.now() + r.schedule.everyMs).toISOString();
  const runsList = routineRuns.get(r.id);
  runsList.unshift({
    ts: now(),
    status: "ok",
    durationMs: Date.now() - started + 800 + Math.floor(Math.random() * 600),
    ...(sessionId ? { sessionId } : {}),
    payloadKind: r.payload.kind,
    output: r.id === ciWatch.id ? "latest 5 runs green" : "nothing changed since the last run",
    delivery: { kind: r.delivery.kind, ok: true },
    tokens: { in: 600 + Math.floor(Math.random() * 200), out: 20 + Math.floor(Math.random() * 30) },
  });
  if (runsList.length > 50) runsList.length = 50;
  publish(`routines.fired/${sessionId ?? "no-session"}`, { routineId: r.id, sessionId, firedAt: r.lastRunAt, status: "ok" });
  log("info", "routines", "routine fired", { routine: r.name, manual });
  return sessionId;
}

setTimeout(() => {
  fireRoutine(ciWatch);
  setInterval(() => {
    if (ciWatch.enabled && routines.has(ciWatch.id)) fireRoutine(ciWatch);
  }, 60_000);
}, 40_000);

const AMBIENT = [
  () => ["debug", "llm", "cache hit", { sessionId: reviewer.id, ratio: Number((0.7 + Math.random() * 0.25).toFixed(2)) }],
  () => ["info", "subagents", "heartbeat", { running: [...sessions.values()].filter((s) => s.parentSessionId && s.status === "running").length }],
  () => {
    const pending = approvals.filter((a) => a.status === "pending");
    return pending.length
      ? ["info", "approvals", "waiting on a decision", { pending: pending.length, oldestSec: Math.floor((Date.now() - Date.parse(pending[0].createdAt)) / 1000) }]
      : ["debug", "approvals", "queue empty", {}];
  },
  () => ["debug", "ws", "ping", { clients: clients.size }],
  () => ["info", "memcore", "ingest batch", { messages: 4 + Math.floor(Math.random() * 12), ms: 40 + Math.floor(Math.random() * 90) }],
];
let ambientIdx = 0;
setInterval(() => {
  const [level, source, msg, bindings] = AMBIENT[ambientIdx++ % AMBIENT.length]();
  log(level, source, msg, bindings);
}, 7000);

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function need(p, key) {
  const v = p?.[key];
  if (typeof v !== "string" || v === "") throw new RpcError("invalid_params", `invalid params: ${key} is required`);
  return v;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new RpcError("not_found", `session not found: ${id}`);
  return s;
}

function findTask(sessionId, taskId) {
  const t = (taskLists.get(rootOf(sessionId)) ?? []).find((x) => x.id === taskId);
  if (!t) throw new RpcError("not_found", `task not found: ${taskId}`);
  return t;
}

function findQuestion(id) {
  const q = questions.find((x) => x.id === id);
  if (!q) throw new RpcError("not_found", `question not found: ${id}`);
  if (q.status !== "pending") throw new RpcError("conflict", `question ${id} is already ${q.status}`);
  return q;
}

function findApproval(id) {
  const a = approvals.find((x) => x.id === id);
  if (!a) throw new RpcError("not_found", `approval not found: ${id}`);
  if (a.status !== "pending") throw new RpcError("conflict", `approval ${id} is already ${a.status}`);
  return a;
}

function getPlugin(id) {
  const p = plugins.get(id);
  if (!p) throw new RpcError("not_found", `plugin not found: ${id}`);
  return p;
}

function getRoutine(id) {
  const r = routines.get(id);
  if (!r) throw new RpcError("not_found", `routine not found: ${id}`);
  return r;
}

const byTime = (key) => (a, b) => Date.parse(a[key]) - Date.parse(b[key]);

/** The persisted tool-call audit trail, derived from the transcript so the two always agree. */
function toolCallsFor(sessionId) {
  const out = [];
  const results = new Map();
  for (const m of transcripts.get(sessionId) ?? []) {
    for (const b of m.content) if (b.type === "tool_result") results.set(b.toolUseId, b);
  }
  for (const m of transcripts.get(sessionId) ?? []) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id);
      const waiting = approvals.find((a) => a.toolCallId === b.id && a.status === "pending");
      out.push({
        id: `tc_${b.id.slice(6)}`,
        sessionId,
        runId: "run-seed",
        name: b.name,
        input: b.input,
        result: r ? r.content : null,
        isError: Boolean(r?.isError),
        status: r ? (r.isError ? "failed" : "completed") : waiting ? "pending" : "approved",
        createdAt: m.createdAt,
        llmToolUseId: b.id,
      });
    }
  }
  return out;
}

function subagentTree(sessionId) {
  const s = getSession(sessionId);
  const kids = [...sessions.values()].filter((c) => c.parentSessionId === s.id).sort(byTime("createdAt"));
  return {
    sessionId: s.id,
    subagent: s.subagentDefId,
    // The gateway's mapping from session status to tree status.
    status: s.status === "running" ? "running" : s.status === "ended" ? "completed" : "queued",
    children: kids.map((c) => subagentTree(c.id)),
  };
}

/** A small stand-in for FTS5: case-insensitive substring match, with the same `<<…>>` snippet markers. */
function searchTranscripts(query, limit, onlySession) {
  const needle = query.toLowerCase();
  const hits = [];
  for (const [sessionId, msgs] of transcripts) {
    if (onlySession && sessionId !== onlySession) continue;
    for (const m of msgs) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const body = m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      const at = body.toLowerCase().indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - 60);
      const end = Math.min(body.length, at + needle.length + 60);
      const snippet =
        (start > 0 ? "…" : "") +
        body.slice(start, at) +
        "<<" +
        body.slice(at, at + needle.length) +
        ">>" +
        body.slice(at + needle.length, end) +
        (end < body.length ? "…" : "");
      hits.push({ session: sessions.get(sessionId), sessionId, messageId: m.id, snippet: snippet.replace(/\s+/g, " "), ts: m.createdAt, score: -1 / (1 + at) });
    }
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit);
}

function routineFromInput(p) {
  if (p.schedule && p.payload) {
    return {
      name: need(p, "name"),
      enabled: p.enabled ?? true,
      schedule: p.schedule,
      payload: p.payload,
      session: p.session ?? { kind: "new" },
      execution: p.execution ?? {},
      ...(p.failure ? { failure: p.failure } : {}),
      delivery: p.delivery ?? { kind: "dashboard" },
    };
  }
  return {
    name: need(p, "name"),
    enabled: p.enabled ?? true,
    schedule: { kind: "cron", expr: need(p, "cron") },
    payload: { kind: "prompt", messages: [{ role: "user", text: need(p, "prompt") }] },
    session: { kind: "new" },
    execution: p.model ? { model: p.model } : {},
    delivery: p.delivery ?? { kind: "dashboard" },
  };
}

const methods = {
  // ---- admin ----
  "admin.health": () => ({
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED) / 1000),
    sessions: {
      active: [...sessions.values()].filter((s) => s.status === "running").length,
      total: sessions.size,
    },
  }),
  "admin.identity": () => ({
    name: SQUAD,
    port: PORT,
    host: HOST,
    build: "mock",
    version: VERSION,
    startedAt: new Date(STARTED).toISOString(),
    branding: {
      agentName: config.branding?.agent_name || "agent",
      userName: config.branding?.user_name || "you",
    },
  }),
  "admin.config": () => ({
    primary: { model: primaryModel() },
    fallbacks: fallbackModels().map((model) => ({ model })),
    providers: Object.keys(config.llm?.providers ?? {}),
    subagents: {
      maxConcurrentGlobal: config.subagents?.max_concurrent_global ?? 8,
      maxConcurrentPerParent: config.subagents?.max_concurrent_per_parent ?? 4,
      maxTreeDepth: config.subagents?.max_tree_depth ?? 3,
    },
    approvals: {
      requireForTags: config.policy?.approvals?.require_for_tags ?? [],
      timeoutSeconds: config.policy?.approvals?.timeout_seconds ?? 900,
    },
  }),
  "admin.config.full": () => ({ config, editable: true, path: "~/.squad/squads/demo/config.json" }),
  "admin.config.set": (p) => {
    setConfigPath(need(p, "path"), p.value);
    log("info", "config", "config path set", { path: p.path });
    return { config };
  },
  "admin.config.unset": (p) => {
    unsetConfigPath(need(p, "path"));
    log("info", "config", "config path unset", { path: p.path });
    return { config };
  },
  "admin.models": () => ({ models }),
  "admin.tools.catalog": () => ({ tools: TOOL_CATALOG }),
  "admin.peers": () => ({ peers }),
  "admin.pair.list": () => ({ pairings: [...pairings.values()] }),
  "admin.pair.approve": (p) => {
    const pairing = pairings.get(need(p, "code"));
    if (!pairing) throw new RpcError("not_found", `pairing not found: ${p.code}`);
    approvePairing(pairing, "cli");
    return { pairing };
  },
  "admin.pair.cancel": (p) => {
    const pairing = pairings.get(need(p, "code"));
    if (!pairing) throw new RpcError("not_found", `pairing not found: ${p.code}`);
    pairing.status = "cancelled";
    pairingTokens.delete(pairing.code);
    publish("pair.cancelled", { pairing });
    return { pairing };
  },

  // ---- sessions ----
  "session.list": (p) => {
    let list = [...sessions.values()];
    if (p.parentSessionId === null) list = list.filter((s) => !s.parentSessionId);
    else if (typeof p.parentSessionId === "string") list = list.filter((s) => s.parentSessionId === p.parentSessionId);
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { sessions: list.slice(0, p.limit ?? 50) };
  },
  "session.start": (p) => {
    const s = addSession({
      title: p.title ?? null,
      model: p.model ?? primaryModel(),
      platform: p.platform ?? null,
      remoteId: p.remoteId ?? null,
    });
    if (Array.isArray(p.fallbacks)) s.fallbacks = p.fallbacks;
    if (p.deliveryMode) s.deliveryMode = p.deliveryMode;
    publish("session.created", { session: s });
    return { session: s };
  },
  "session.resume": (p) => ({ session: getSession(need(p, "sessionId")) }),
  "session.end": (p) => {
    const s = getSession(need(p, "sessionId"));
    setStatus(s, "ended");
    return { session: s };
  },
  "session.rename": (p) => {
    const s = getSession(need(p, "sessionId"));
    s.title = need(p, "title").slice(0, 200);
    touch(s);
    return { session: s };
  },
  "session.setModel": (p) => {
    const s = getSession(need(p, "sessionId"));
    s.model = need(p, "model");
    if (Array.isArray(p.fallbacks)) s.fallbacks = p.fallbacks;
    touch(s);
    return { session: s };
  },
  "session.setTitleModel": (p) => {
    const s = getSession(need(p, "sessionId"));
    s.titleModel = typeof p.titleModel === "string" ? p.titleModel : null;
    touch(s);
    return { session: s };
  },
  "session.search": (p) => ({ hits: searchTranscripts(need(p, "query"), p.limit ?? 20, p.sessionId) }),

  // ---- chat ----
  "chat.history": (p) => {
    const msgs = transcripts.get(getSession(need(p, "sessionId")).id);
    let end = msgs.length;
    if (p.before) {
      const i = msgs.findIndex((m) => m.id === p.before);
      if (i !== -1) end = i;
    }
    const limit = p.limit ?? 100;
    return { messages: msgs.slice(Math.max(0, end - limit), end) };
  },
  "chat.tool_calls": (p) => ({ toolCalls: toolCallsFor(getSession(need(p, "sessionId")).id).slice(-(p.limit ?? 500)) }),
  "chat.send": (p) => {
    const s = getSession(need(p, "sessionId"));
    if (p.content === undefined || p.content === "") throw new RpcError("invalid_params", "invalid params: content is required");
    const content = typeof p.content === "string" ? [text(p.content)] : p.content;
    const message = append(s.id, "user", content);
    publish(`chat.user_message/${s.id}`, { sessionId: s.id, message });
    const script = cannedReply(s, p.content);
    const untitled = !s.title;
    const runId = uuid();
    const active = runs.get(s.id);
    const { queued } = enqueueTurn(s.id, {
      ...script,
      runId,
      done: () => {
        if (untitled && !s.title) {
          const first = content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
          s.title = first.length > 60 ? `${first.slice(0, 57)}…` : first || "New chat";
          touch(s);
        }
      },
    });
    // Queued behind a run already in flight, `runId` names that active run, as the protocol defines it.
    return queued
      ? { message, runId: active?.id ?? runId, status: "queued", queuePosition: 1 }
      : { message, runId, status: "running" };
  },
  "chat.cancel": (p) => {
    const run = runs.get(getSession(need(p, "sessionId")).id);
    if (!run) return { cancelled: false };
    run.cancelled = true;
    return { cancelled: true, runId: run.id };
  },

  // ---- tasks ----
  "tasks.list": (p) => {
    const sid = getSession(need(p, "sessionId")).id;
    let list = taskLists.get(rootOf(sid)) ?? [];
    if (!p.includeDeleted) list = list.filter((t) => t.status !== "deleted");
    if (Array.isArray(p.status)) list = list.filter((t) => p.status.includes(t.status));
    return { tasks: list };
  },
  "tasks.create": (p) => {
    const sid = getSession(need(p, "sessionId")).id;
    const listId = rootOf(sid);
    const t = addTask(listId, {
      subject: need(p, "subject"),
      description: typeof p.description === "string" ? p.description : "",
      owner: p.owner ?? null,
      activeForm: p.activeForm,
      metadata: p.metadata,
      created: now(),
    });
    if (Array.isArray(p.blockedBy)) t.blockedBy = [...p.blockedBy];
    if (Array.isArray(p.blocks)) t.blocks = [...p.blocks];
    publish(`tasks.created/${listId}`, { task: t });
    return { task: t };
  },
  "tasks.update": (p) => {
    const t = findTask(need(p, "sessionId"), need(p, "taskId"));
    return { task: updateTask(t, p) };
  },

  // ---- questions ----
  "questions.list": (p) => {
    let list = questions;
    if (p.sessionId) list = list.filter((q) => q.sessionId === p.sessionId);
    if (Array.isArray(p.status)) list = list.filter((q) => p.status.includes(q.status));
    return { questions: [...list].sort(byTime("askedAt")) };
  },
  "questions.answer": (p) => {
    const q = findQuestion(need(p, "questionId"));
    if (!p.answers || typeof p.answers !== "object") throw new RpcError("invalid_params", "invalid params: answers is required");
    q.status = "answered";
    q.answers = p.answers;
    q.answeredAt = now();
    if (p.annotations) q.annotations = p.annotations;
    publish(`questions.answered/${q.sessionId}`, { question: q });
    log("info", "questions", "question answered", { sessionId: q.sessionId });
    const pick = String(Object.values(p.answers)[0] ?? "");
    enqueueTurn(q.sessionId, q === backoffQuestion ? backoffFollowUp(pick) : { reply: `Thanks. Going with "${pick}".` });
    return { question: q };
  },
  "questions.cancel": (p) => {
    const q = findQuestion(need(p, "questionId"));
    q.status = "cancelled";
    q.answeredAt = now();
    publish(`questions.cancelled/${q.sessionId}`, { question: q });
    if (q === backoffQuestion) {
      enqueueTurn(q.sessionId, {
        reply: "Question dismissed. I'll keep the PR's approach for now and put both options in the review summary so the decision is visible on the PR.",
      });
    }
    return { question: q };
  },

  // ---- approvals ----
  "approvals.list": (p) => {
    let list = approvals;
    if (p.sessionId) list = list.filter((a) => a.sessionId === p.sessionId);
    if (Array.isArray(p.status)) list = list.filter((a) => p.status.includes(a.status));
    return { approvals: [...list].sort(byTime("createdAt")) };
  },
  "approvals.decide": (p) => {
    const a = findApproval(need(p, "approvalId"));
    if (p.decision !== "approve" && p.decision !== "deny") throw new RpcError("invalid_params", "invalid params: decision must be approve or deny");
    decide(a, p.decision, p.reason ?? null);
    return { approval: a };
  },
  "approvals.allow_path": (p) => {
    const a = findApproval(need(p, "approvalId"));
    const target = typeof a.input?.command === "string" ? a.input.command : typeof a.input?.path === "string" ? a.input.path : null;
    const rule = {
      id: uuid(),
      toolName: a.toolName,
      target: p.scope === "tool" ? null : target,
      label: null,
      createdAt: now(),
      createdBy: "dashboard",
      decision: "approve",
      scope: { kind: "global" },
    };
    approvalRules.push(rule);
    publish("approvals.rule_added", { rule });
    decide(a, "approve", "always allowed");
    return { approval: a, rule };
  },

  // ---- subagents ----
  "subagents.tree": (p) => ({ root: subagentTree(need(p, "rootSessionId")) }),
  "subagents.list": () => ({ definitions: subagentDefs }),

  // ---- plugins ----
  "plugins.list": () => ({ plugins: [...plugins.values()] }),
  "plugins.enable": (p) => setPluginEnabled(getPlugin(need(p, "id")), true),
  "plugins.disable": (p) => setPluginEnabled(getPlugin(need(p, "id")), false),
  "plugins.reload": (p) => {
    const plugin = getPlugin(need(p, "id"));
    publish("plugins.changed", { plugin });
    log(plugin.status === "failed" ? "error" : "info", "plugins", plugin.status === "failed" ? "plugin load failed" : "plugin reloaded", { plugin: plugin.id });
    return { plugin };
  },
  "plugins.catalog": () => ({
    entries: catalog.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      kinds: c.kinds,
      source: c.source,
      requires: c.requires,
      installed: plugins.has(c.id),
      loaded: plugins.get(c.id)?.status === "loaded",
    })),
  }),
  "plugins.describe": (p) => {
    const c = catalogById.get(need(p, "id"));
    if (!c) throw new RpcError("not_found", `no catalog entry for ${p.id}`);
    const current = plugins.get(c.id)?.config;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      fields: c.fields,
      defaultConfig: c.defaultConfig,
      ...(current ? { currentConfig: current } : {}),
      needsAuthToken: c.needsAuthToken,
      secrets: c.secrets,
      setupPlaybook: `Goal: get ${c.name} installed. In the demo gateway every secret already reads as set, so install goes straight through.`,
    };
  },
  "plugins.install": (p) => {
    const c = catalogById.get(need(p, "id"));
    if (!c) throw new RpcError("not_found", `no catalog entry for ${p.id}`);
    const existing = plugins.get(c.id);
    if (existing?.status === "loaded") return { plugin: existing, alreadyInstalled: true };
    const plugin = pluginFromCatalog(c, { ...c.defaultConfig, ...(p.config ?? {}) });
    plugins.set(c.id, plugin);
    publish("plugins.changed", { plugin });
    log("info", "plugins", "plugin installed", { plugin: c.id });
    return { plugin };
  },
  "plugins.uninstall": (p) => {
    const plugin = getPlugin(need(p, "id"));
    plugins.delete(plugin.id);
    publish("plugins.changed", { plugin: { ...plugin, enabled: false } });
    log("info", "plugins", "plugin uninstalled", { plugin: plugin.id });
    return { id: plugin.id };
  },
  "plugins.start_setup_chat": (p) => {
    const c = catalogById.get(need(p, "id"));
    if (!c) throw new RpcError("not_found", `no catalog entry for ${p.id}`);
    const s = addSession({ title: `Set up ${c.name}`, model: primaryModel() });
    publish("session.created", { session: s });
    return { sessionId: s.id, seedMessage: `Help me set up the ${c.name} plugin. Walk me through anything I have to do outside the dashboard.` };
  },

  // ---- channels, apps, logs ----
  "channels.list": () => ({ channels }),
  "apps.list": () => ({ apps: apps.map((a) => ({ ...a, lastProbeAt: Date.now() - 4000 })) }),
  "logs.tail": (p) => {
    const min = LEVEL_RANK[p.level ?? "trace"] ?? 0;
    const q = typeof p.q === "string" ? p.q.toLowerCase() : "";
    const list = logs.filter((e) => {
      if (LEVEL_RANK[e.level] < min) return false;
      if (p.source && e.source !== p.source) return false;
      if (typeof p.sinceId === "number" && e.id <= p.sinceId) return false;
      if (q && !`${e.msg} ${e.source} ${JSON.stringify(e.bindings)}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      entries: list.slice(-(p.limit ?? 500)),
      sources: [...new Set(logs.map((e) => e.source).filter(Boolean))].sort(),
    };
  },

  // ---- routines ----
  "routines.list": () => ({ routines: [...routines.values()] }),
  "routines.create": (p) => {
    const r = addRoutine(routineFromInput(p));
    log("info", "routines", "routine created", { routine: r.name });
    return { routine: r };
  },
  "routines.update": (p) => {
    const r = getRoutine(need(p, "id"));
    for (const k of ["name", "enabled", "schedule", "payload", "session", "execution", "failure", "delivery"]) {
      if (p[k] !== undefined) r[k] = p[k];
    }
    if (p.cron !== undefined) r.schedule = { kind: "cron", expr: p.cron };
    if (p.prompt !== undefined) r.payload = { kind: "prompt", messages: [{ role: "user", text: p.prompt }] };
    if (p.model !== undefined) r.execution = { ...r.execution, model: p.model };
    syncLegacy(r);
    if (r.schedule.kind === "interval" && !r.enabled) r.nextRunAt = null;
    return { routine: r };
  },
  "routines.delete": (p) => {
    const r = getRoutine(need(p, "id"));
    routines.delete(r.id);
    return { id: r.id };
  },
  "routines.run_now": (p) => ({ sessionId: fireRoutine(getRoutine(need(p, "id")), { manual: true }) }),
  "routines.runs": (p) => {
    let list = routineRuns.get(getRoutine(need(p, "jobId")).id);
    if (p.status) list = list.filter((r) => r.status === p.status);
    return { runs: list.slice(0, p.limit ?? 50) };
  },
  "routines.tail": (p) => ({ runs: routineRuns.get(getRoutine(need(p, "jobId")).id).slice(0, p.limit ?? 10) }),
};

function decide(a, decision, reason) {
  a.status = decision === "approve" ? "approved" : "denied";
  a.decision = decision;
  a.reason = reason;
  a.decidedBy = "dashboard";
  a.decidedAt = now();
  publish(`approvals.decided/${a.sessionId}`, { approval: a });
  log("info", "approvals", "approval decided", { tool: a.toolName, decision });
  if (a === testApproval) enqueueTurn(tester.id, testerAfterApproval(decision === "approve"));
}

function setPluginEnabled(plugin, enabled) {
  plugin.enabled = enabled;
  publish("plugins.changed", { plugin });
  return { plugin };
}

function approvePairing(pairing, by) {
  pairing.status = "approved";
  pairing.approvedAt = now();
  pairing.approvedBy = by;
  pairingTokens.set(pairing.code, `demo-${crypto.randomBytes(12).toString("hex")}`);
  publish("pair.approved", { pairing });
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function respond(client, id, ok, payload) {
  client.conn.sendText(JSON.stringify(ok ? { type: "response", id, ok: true, result: payload } : { type: "response", id, ok: false, error: payload }));
}

async function onFrame(client, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch (err) {
    respond(client, "unknown", false, { code: "parse_error", message: "invalid JSON", data: { reason: String(err.message) } });
    return;
  }
  const id = frame && typeof frame === "object" && typeof frame.id === "string" && frame.id ? frame.id : null;
  // Clients have no business sending responses or events; the gateway drops them.
  if (id && (frame.type === "response" || frame.type === "event")) return;
  if (!id || !["request", "subscribe", "unsubscribe"].includes(frame.type)) {
    respond(client, "unknown", false, { code: "invalid_frame", message: "invalid frame" });
    return;
  }

  if (frame.type === "subscribe" || frame.type === "unsubscribe") {
    const topics = frame.topics;
    if (!Array.isArray(topics) || topics.length === 0 || !topics.every((t) => typeof t === "string" && t)) {
      respond(client, "unknown", false, { code: "invalid_frame", message: "invalid frame" });
      return;
    }
    for (const t of topics) {
      if (frame.type === "subscribe") client.topics.add(t);
      else client.topics.delete(t);
    }
    respond(client, id, true, { topics });
    if (frame.type === "subscribe") startStory();
    return;
  }

  if (typeof frame.method !== "string" || !frame.method) {
    respond(client, "unknown", false, { code: "invalid_frame", message: "invalid frame" });
    return;
  }
  const handler = Object.hasOwn(methods, frame.method) ? methods[frame.method] : null;
  if (!handler) {
    // A proper error rather than silence: the dashboard wraps most reads in a
    // fallback and degrades to an empty state, but only if an answer arrives.
    log("warn", "dispatch", "unknown method", { method: frame.method });
    respond(client, id, false, { code: "unknown_method", message: `unknown method: ${frame.method}` });
    return;
  }
  const params = frame.params && typeof frame.params === "object" ? frame.params : {};
  try {
    respond(client, id, true, await handler(params, client));
  } catch (err) {
    if (err instanceof RpcError) {
      respond(client, id, false, { code: err.code, message: err.message });
    } else {
      log("error", "dispatch", "dispatch error", { method: frame.method, error: String(err?.message ?? err) });
      respond(client, id, false, { code: "internal_error", message: String(err?.message ?? err) });
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket (RFC 6455), server side only
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 16 * 1024 * 1024;

class WsConnection {
  constructor(socket, { onText, onClose }) {
    this.socket = socket;
    this.onText = onText;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.feed(chunk));
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const frame = this.parse();
      if (!frame) break;
      this.handle(frame);
    }
  }

  /** One frame off the front of the buffer, unmasked; null until a whole frame has arrived. */
  parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) {
        this.fail(1009, "message too big");
        return null;
      }
      len = Number(big);
      off = 10;
    }
    // A client MUST mask every frame (RFC 6455 §5.1); a server that gets an
    // unmasked one closes the connection.
    if (!masked) {
      this.fail(1002, "client frames must be masked");
      return null;
    }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { fin, opcode, payload };
  }

  handle({ fin, opcode, payload }) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragmentOpcode) return this.fail(1002, "unexpected continuation frame");
        this.fragments.push(payload);
        if (fin) {
          const op = this.fragmentOpcode;
          const data = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = 0;
          this.deliver(op, data);
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (this.fragmentOpcode) return this.fail(1002, "expected a continuation frame");
        if (fin) return this.deliver(opcode, payload);
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      case 0x8: // close: echo the status code back, then hang up
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.end();
        return;
      case 0x9: // ping
        this.sendFrame(0xa, payload);
        return;
      case 0xa: // pong
        this.alive = true;
        return;
      default:
        this.fail(1002, "unknown opcode");
    }
  }

  deliver(opcode, data) {
    if (opcode === 0x2) return this.fail(1003, "text frames only");
    this.onText(data.toString("utf8"));
  }

  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65_536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN, never fragmented, never masked (server to client)
    this.socket.write(Buffer.concat([header, payload]));
  }

  sendText(str) {
    this.sendFrame(0x1, Buffer.from(str, "utf8"));
  }

  ping() {
    this.sendFrame(0x9);
  }

  fail(code, reason) {
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this.sendFrame(0x8, p);
    this.end();
  }

  end() {
    if (!this.open) return;
    this.socket.end();
    this.closed();
  }

  closed() {
    if (!this.open) return;
    this.open = false;
    this.onClose();
  }

  destroy() {
    this.socket.destroy();
    this.closed();
  }
}

// Drop sockets that stop answering pings, so a closed laptop lid does not
// leave a subscriber behind forever. Browsers answer pings on their own.
setInterval(() => {
  for (const c of clients) {
    if (!c.conn.alive) {
      c.conn.destroy();
      continue;
    }
    c.conn.alive = false;
    c.conn.ping();
  }
}, 30_000);

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === "string" && h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

// ---------------------------------------------------------------------------
// HTTP: pairing, the sample app, and the upgrade to /ws
// ---------------------------------------------------------------------------

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "content-type": "application/json", "content-length": buf.byteLength });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pairCode = () =>
  [0, 1].map(() => [...crypto.randomBytes(5)].map((x) => PAIR_ALPHABET[x % PAIR_ALPHABET.length]).join("")).join("-");

/** The page `/apps/retry-viz/` serves inside the Apps view's iframe. */
function retryVizPage() {
  const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => 2 ** n * 0.25);
  const max = delays.at(-1);
  const bars = delays
    .map((d, i) => {
      const h = Math.max(2, (d / max) * 220);
      const x = 40 + i * 70;
      return `<rect x="${x}" y="${250 - h}" width="44" height="${h}" rx="3" fill="${d > 10 ? "#e5a33d" : "#5b8def"}"/>` +
        `<text x="${x + 22}" y="${242 - h}" text-anchor="middle">${d < 1 ? d.toFixed(1) : d}s</text>` +
        `<text x="${x + 22}" y="272" text-anchor="middle" class="dim">#${i + 1}</text>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Retry timeline</title>
<style>
  body { margin: 0; padding: 24px; background: #0f1115; color: #d7dae0; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 15px; margin: 0 0 4px; color: #f1f3f6; }
  p { margin: 0 0 18px; color: #8b919c; }
  svg text { fill: #d7dae0; font: 11px ui-monospace, monospace; }
  svg text.dim { fill: #8b919c; }
  .note { margin-top: 14px; color: #e5a33d; }
</style></head><body>
<h1>Retry timeline</h1>
<p>Delay before each delivery attempt in PR #42 (jitter omitted). Sample app served by the demo gateway.</p>
<svg width="620" height="290" viewBox="0 0 620 290" role="img" aria-label="Delay per attempt">${bars}
<line x1="30" y1="250" x2="610" y2="250" stroke="#2a2f3a"/></svg>
<div class="note">Attempts 6 to 8 wait longer than the 10 s cap the reviewer suggested.</div>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Browser pairing: the same two unauthenticated routes as the gateway. A
  // pairing approves itself 1.5 s after it starts.
  if (req.method === "POST" && url.pathname === "/pair/begin") {
    let label = "Browser";
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (typeof body.label === "string" && body.label) label = body.label;
    } catch {
      json(res, 400, { error: "invalid body" });
      return;
    }
    const pairing = {
      code: pairCode(),
      label,
      scopes: ["*"],
      status: "pending",
      createdAt: now(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      approvedAt: null,
      approvedBy: null,
      claimedAt: null,
      persistent: false,
    };
    pairings.set(pairing.code, pairing);
    publish("pair.requested", { pairing });
    setTimeout(() => {
      if (pairing.status === "pending") approvePairing(pairing, "demo-auto");
    }, 1500);
    json(res, 200, { pairing });
    return;
  }
  if (req.method === "GET" && url.pathname === "/pair/poll") {
    const code = url.searchParams.get("code");
    if (!code) {
      json(res, 400, { error: "missing code" });
      return;
    }
    const pairing = pairings.get(code);
    if (!pairing) {
      json(res, 200, { status: "expired" });
      return;
    }
    const token = pairingTokens.get(code);
    if (pairing.status === "approved" && token) {
      pairingTokens.delete(code);
      pairing.status = "claimed";
      pairing.claimedAt = now();
      json(res, 200, { status: "approved", token, label: pairing.label, expiresAt: pairing.expiresAt });
      return;
    }
    json(res, 200, { status: pairing.status });
    return;
  }

  if (req.method === "GET" && url.pathname === "/apps/retry-viz/") {
    const body = Buffer.from(retryVizPage());
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.byteLength });
    res.end(body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `Squad demo gateway on ws://${HOST}:${PORT}/ws (any non-empty token).\n\n` +
        `Run the dashboard against it:\n  SQUAD_GATEWAY=http://${HOST}:${PORT} pnpm --filter @squad/dashboard dev\n`,
    );
    return;
  }

  json(res, 404, { error: "not found" });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token = bearer(req) || url.searchParams.get("token") || "";
  if (!token.trim()) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || String(req.headers.upgrade).toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  // No Sec-WebSocket-Extensions in the answer: permessage-deflate is declined,
  // so every frame arrives uncompressed and the parser stays small.
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const client = { topics: new Set(), conn: null };
  client.conn = new WsConnection(socket, {
    onText: (raw) => void onFrame(client, raw),
    onClose: () => {
      clients.delete(client);
      log("info", "ws", "client disconnected", { clients: clients.size });
    },
  });
  clients.add(client);
  log("info", "ws", "client connected", { clients: clients.size });
  if (head?.length) client.conn.feed(head);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `squad demo gateway on ws://${HOST}:${PORT}/ws (any non-empty token)\n` +
      `dashboard: SQUAD_GATEWAY=http://${HOST}:${PORT} pnpm --filter @squad/dashboard dev\n`,
  );
});
