import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ProtocolClient } from "../protocol-client.js";
import * as render from "../render.js";
import { resolveEnv } from "../env.js";
import { getLastSessionId, setLastSessionId, clearLastSessionId } from "../session-store.js";
import { printWelcomeBanner, currentVersion } from "../ui/banner.js";
import { getRandomTip } from "../ui/tips.js";
import { brandString, roleColor } from "../ui/skin.js";
import { loadGatewayBranding } from "../ui/branding-runtime.js";
import { C, color, fg } from "../ui/colors.js";
import { renderStatusbar, isStatusbarEnabled } from "../ui/statusbar.js";
import { runSlash, matchCommands } from "../ui/slash.js";
import { Spinner } from "../ui/spinner.js";
import { LineInput, type MenuItem } from "../ui/line-input.js";
import type { Task, QuestionRecord, ApprovalRecord } from "@squad/protocol";

const HISTORY_PATH = join(homedir(), ".squad", "history");
const HISTORY_MAX = 1000;

function loadHistory(): string[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean).slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

function appendHistory(line: string): void {
  try {
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    appendFileSync(HISTORY_PATH, line + "\n");
  } catch {
    // best-effort
  }
}

function promptString(): string {
  const sym = brandString("prompt_symbol", "▸");
  return color(`${sym} `, fg(roleColor("prompt", "#5EE1FF")), C.BOLD);
}

export async function runRepl(opts: { resume?: boolean } = {}): Promise<void> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  // Pull `agent_name` / `user_name` / `subagent_name` from the gateway so
  // the welcome banner, prompt symbol, transcript labels, and tips all use
  // the install's configured branding instead of the skin's defaults.
  await loadGatewayBranding(client);

  // ── session resolution ────────────────────────────────────────────────────
  let sessionId: string;
  const existing = opts.resume ? getLastSessionId() : undefined;
  if (existing) {
    try {
      const { session } = await client.request("session.resume", { sessionId: existing });
      sessionId = session.id;
    } catch {
      clearLastSessionId();
      const { session } = await client.request("session.start", {});
      sessionId = session.id;
    }
  } else {
    const { session } = await client.request("session.start", {});
    sessionId = session.id;
  }
  setLastSessionId(sessionId);

  const subscribedTopics = (sid: string): string[] => [
    `chat.*/${sid}`,
    `tasks.*/${sid}`,
    `questions.*/${sid}`,
    `approvals.*/${sid}`,
    `subagents.spawned/${sid}`,
    `subagents.completed/${sid}`,
    `subagents.failed/${sid}`,
  ];

  // Mutable state shared with slash handlers.
  const state = {
    sessionId,
    verbose: "compact" as import("../ui/render.js").VerboseLevel,
    shouldExit: false,
    pendingQuestion: null as QuestionRecord | null,
    // Index into pendingQuestion.input.questions of the sub-question the
    // user is currently answering. Only meaningful when pendingQuestion
    // is set; reset to 0 each time a new record is started.
    pendingSubIdx: 0,
    // Answers accumulated for the active record while the user walks
    // through its sub-questions one at a time. Submitted as a single
    // questions.answer call once every sub-question has a value.
    pendingAnswers: {} as Record<string, string>,
    // True between the user typing "o"/"other" and submitting the next
    // line, which is then taken verbatim as the freeform answer for the
    // current sub-question.
    awaitingFreeform: false,
    // Records that arrived while another was being answered. Drained in
    // FIFO order each time the active question is fully answered.
    questionQueue: [] as QuestionRecord[],
    pendingApproval: null as ApprovalRecord | null,
    taskCount: 0,
    openQuestions: 0,
    pendingApprovals: 0,
    activeSubagents: 0,
    tokensIn: 0,
    tokensOut: 0,
    onSessionChange: async (newId: string) => {
      try {
        await client.unsubscribe(subscribedTopics(state.sessionId));
      } catch {
        // ignore — stale subs are harmless
      }
      state.sessionId = newId;
      setLastSessionId(newId);
      state.activeSubagents = 0;
      state.pendingApprovals = 0;
      state.pendingApproval = null;
      state.pendingQuestion = null;
      state.pendingSubIdx = 0;
      state.pendingAnswers = {};
      state.awaitingFreeform = false;
      state.questionQueue = [];
      await client.subscribe(subscribedTopics(newId));
      await refreshTaskCount(client, state);
      await refreshOpenQuestions(client, state);
      await refreshSessionTokens(client, state);
    },
  };

  await client.subscribe(subscribedTopics(sessionId));

  printWelcomeBanner({
    version: currentVersion(),
    gatewayUrl: env.url,
    sessionId,
    cwd: process.cwd(),
    tokenSet: Boolean(env.token),
    tip: getRandomTip(),
  });

  // Track runs that already streamed deltas — non-streaming providers skip
  // chat.text_delta and ship one big chat.assistant_message.
  const streamedRuns = new Set<string>();

  // While `activeRunId` is set, input is paused and the spinner owns the
  // bottom line. Event handlers restart the input once the run ends.
  let activeRunId: string | null = null;
  const spinner = new Spinner("thinking");
  const stopSpinner = (): void => {
    if (activeRunId !== null) spinner.stop();
    activeRunId = null;
  };

  // Live slash-command menu provider. Returns `[]` to hide the menu.
  const menuProvider = (buffer: string): MenuItem[] => {
    const matches = matchCommands(buffer);
    return matches.map((c) => ({
      name: c.name,
      summary: c.summary,
      ...(c.usage ? { usage: c.usage } : {}),
      ...(c.aliases && c.aliases.length > 0 ? { aliases: c.aliases.slice() } : {}),
    }));
  };

  const input = new LineInput({
    prompt: promptString,
    menuProvider,
    initialHistory: loadHistory(),
    historyLimit: HISTORY_MAX,
    onHistoryAppend: appendHistory,
  });

  /**
   * Write output that might collide with the live input area or spinner.
   * During a run the spinner owns the bottom line; between turns the input
   * does. Either way we need to suspend the live layer, write, restore.
   */
  const printSafely = (fn: () => void): void => {
    if (activeRunId !== null) {
      spinner.stop();
      fn();
      spinner.start();
    } else {
      input.pause();
      fn();
      input.resume();
    }
  };

  // Tiered Ctrl+C: first press warns, second within 2s exits. Works during
  // a run too — the keypress handler surfaces ctrl+c even when input is
  // paused so the user is never stuck while the agent is thinking.
  let lastInterruptAt = 0;
  const exitNow = (): void => {
    // Stop every live region before writing the goodbye so it lands cleanly.
    spinner.stop();
    activeRunId = null;
    input.pause();
    process.stdout.write(
      `\n${color(brandString("goodbye", "see you."), fg(roleColor("accent")))}\n`,
    );
    state.shouldExit = true;
    input.stop();
  };

  input.on("interrupt", () => {
    const now = Date.now();
    if (now - lastInterruptAt < 2000) {
      exitNow();
      return;
    }
    lastInterruptAt = now;
    if (activeRunId !== null) {
      // Agent is thinking. Leave the run running on the gateway (we don't
      // have a cancel method yet), but stop the spinner so the user can see
      // the hint. The run's events will keep streaming above the hint.
      spinner.stop();
      process.stdout.write(
        "\n" + color("(ctrl-c again within 2s to exit)", fg(roleColor("muted"))) + "\n",
      );
      // Re-arm the spinner so the user can see the agent is still working.
      spinner.setLabel("still working — ctrl-c again to exit");
      spinner.start();
    } else {
      render.endDeltaBlock();
      printSafely(() => {
        process.stdout.write(
          color("(ctrl-c again within 2s to exit)\n", fg(roleColor("muted"))),
        );
      });
    }
  });

  input.on("exit", () => {
    exitNow();
  });

  client.onEvent((topic, data) => {
    if (topic.startsWith("chat.text_delta/")) {
      const d = data as { delta: string; runId?: string };
      if (d.runId) streamedRuns.add(d.runId);
      if (activeRunId && d.runId === activeRunId) stopSpinner();
      render.renderDelta(d.delta);
    } else if (topic.startsWith("chat.assistant_message/")) {
      const d = data as {
        runId: string;
        message: { content: Array<{ type: string; text?: string }> };
      };
      if (activeRunId && d.runId === activeRunId) stopSpinner();
      if (!streamedRuns.has(d.runId)) {
        const text = d.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (text) render.renderDelta(text);
      }
      streamedRuns.delete(d.runId);
      render.renderNewline();
      activeRunId = null;
      // Refresh the cumulative token counts for the statusbar second line.
      void refreshSessionTokens(client, state);
      prePrompt();
    } else if (topic.startsWith("chat.tool_call/")) {
      const d = data as {
        name: string;
        input: unknown;
        runId?: string;
        toolCallId?: string;
      };
      const underRun = activeRunId !== null && d.runId === activeRunId;
      if (underRun) spinner.stop();
      render.renderToolCallStart(d.name, d.input, state.verbose, d.toolCallId);
      if (underRun) {
        spinner.setLabel(d.name);
        spinner.start();
      }
    } else if (topic.startsWith("chat.tool_result/")) {
      const d = data as {
        runId?: string;
        result: unknown;
        isError?: boolean;
        toolCallId?: string;
      };
      const underRun = activeRunId !== null && d.runId === activeRunId;
      if (underRun) spinner.stop();
      render.renderToolResult(d.result, Boolean(d.isError), d.toolCallId);
      if (underRun) {
        spinner.setLabel("thinking");
        spinner.start();
      }
    } else if (topic.startsWith("chat.error/")) {
      stopSpinner();
      render.renderError(`run failed: ${(data as { message: string }).message}`);
      prePrompt();
    } else if (topic.startsWith("tasks.")) {
      void refreshTaskCount(client, state);
    } else if (topic.startsWith("questions.asked/")) {
      const q = (data as { question: QuestionRecord }).question;
      state.openQuestions = (state.openQuestions ?? 0) + 1;
      if (state.pendingQuestion) {
        // Already answering one — queue this for after.
        state.questionQueue.push(q);
      } else {
        startQuestion(q);
      }
    } else if (
      topic.startsWith("questions.answered/") ||
      topic.startsWith("questions.cancelled/") ||
      topic.startsWith("questions.timed_out/")
    ) {
      const q = (data as { question: QuestionRecord }).question;
      state.openQuestions = Math.max(0, (state.openQuestions ?? 1) - 1);
      // If the gateway-side resolution races our local clear (e.g. timeout
      // fires while the user is mid-answer), drop the active entry too so
      // the REPL doesn't keep prompting for a question that's gone.
      if (state.pendingQuestion?.id === q.id) {
        clearActiveQuestion();
      } else {
        state.questionQueue = state.questionQueue.filter((x) => x.id !== q.id);
      }
    } else if (
      topic.startsWith("approvals.requested/") ||
      topic.startsWith("approvals.pending/")
    ) {
      const approval = (data as { approval: ApprovalRecord }).approval;
      // Coalesce the two events: `pending` and `requested` fire together.
      if (state.pendingApproval?.id === approval.id) return;
      state.pendingApproval = approval;
      state.pendingApprovals += 1;
      // Same logic as ask_user: stop the spinner (the agent is blocked on
      // us, not thinking), print the prompt, and force the input to show
      // even mid-run.
      if (activeRunId !== null) spinner.stop();
      process.stdout.write(renderApprovalPrompt(approval));
      forceShowInput();
    } else if (topic.startsWith("approvals.decided/")) {
      const approval = (data as { approval: ApprovalRecord }).approval;
      const wasActive = state.pendingApproval?.id === approval.id;
      if (wasActive) state.pendingApproval = null;
      state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
      // Hand the bottom row back to the spinner if we held it open just
      // for this approval and a run is still going.
      if (
        wasActive &&
        activeRunId !== null &&
        !state.pendingQuestion &&
        !state.pendingApproval
      ) {
        spinner.setLabel("thinking");
        spinner.start();
        input.pause();
      }
    } else if (topic.startsWith("subagents.spawned/")) {
      state.activeSubagents += 1;
    } else if (
      topic.startsWith("subagents.completed/") ||
      topic.startsWith("subagents.failed/")
    ) {
      state.activeSubagents = Math.max(0, state.activeSubagents - 1);
    }
  });

  // Seed counts for the statusbar.
  void refreshTaskCount(client, state);
  void refreshOpenQuestions(client, state);

  /**
   * The agent has called ask_user and is now blocked on us. We need to
   * stop the spinner (it's lying — the agent isn't thinking, it's
   * waiting), surface the question, and resume the input even if a run is
   * still active. The spinner restarts only after the user finishes
   * answering all sub-questions and the run continues.
   */
  function startQuestion(q: QuestionRecord): void {
    state.pendingQuestion = q;
    state.pendingSubIdx = 0;
    state.pendingAnswers = {};
    state.awaitingFreeform = false;
    if (activeRunId !== null) spinner.stop();
    process.stdout.write(render.renderAskPrompt(q, 0, {}));
    forceShowInput();
  }

  function clearActiveQuestion(): void {
    // Idempotent: the local line-handler path and the questions.answered
    // event both want to drive the queue + spinner restart, and they race
    // by milliseconds. If pendingQuestion is already null and there's
    // nothing queued, the first caller already finished; bail out so we
    // don't double-start the spinner.
    if (state.pendingQuestion === null && state.questionQueue.length === 0) {
      return;
    }
    state.pendingQuestion = null;
    state.pendingSubIdx = 0;
    state.pendingAnswers = {};
    state.awaitingFreeform = false;
    const next = state.questionQueue.shift();
    if (next) {
      startQuestion(next);
      return;
    }
    // No more questions. If a run is still active, hand the bottom row
    // back to the spinner; otherwise let prePrompt take over.
    if (activeRunId !== null) {
      spinner.setLabel("thinking");
      spinner.start();
      input.pause();
    } else {
      prePrompt();
    }
  }

  /**
   * Force the input row to be visible even when a run is active. Used
   * exclusively for ask_user/approval prompts where the agent is blocked
   * on the user — without this, the spinner stays up and prePrompt() bails
   * because activeRunId is still set, leaving the user unable to type.
   */
  function forceShowInput(): void {
    if (state.shouldExit) return;
    if (isStatusbarEnabled()) {
      renderStatusbar({
        sessionId: state.sessionId,
        pendingQuestion: Boolean(state.pendingQuestion),
        taskCount: state.taskCount,
        openQuestions: state.openQuestions,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        activeSubagents: state.activeSubagents,
        pendingApprovals: state.pendingApprovals,
      });
    }
    if (!input.isRunning()) input.start();
    else input.resume();
  }

  function prePrompt(): void {
    if (state.shouldExit) return;
    // While a run is in flight we normally let the spinner own the bottom
    // line — but if the agent is blocked on a question or approval, we
    // *must* keep the input row up so the user can answer.
    if (activeRunId !== null && !state.pendingQuestion && !state.pendingApproval) return;
    if (isStatusbarEnabled()) {
      renderStatusbar({
        sessionId: state.sessionId,
        pendingQuestion: Boolean(state.pendingQuestion),
        taskCount: state.taskCount,
        openQuestions: state.openQuestions,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        activeSubagents: state.activeSubagents,
        pendingApprovals: state.pendingApprovals,
      });
    }
    if (!input.isRunning()) input.start();
    else input.resume();
  }

  input.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty submit — redraw prompt.
      prePrompt();
      return;
    }
    // Pause input while we dispatch the line so concurrent event output
    // doesn't race with the next render.
    input.pause();

    try {
      if (trimmed.startsWith("/")) {
        await runSlash(trimmed, { client, state, input });
      } else if (state.pendingApproval) {
        const handled = await handleApprovalAnswer(client, state.pendingApproval, trimmed);
        if (handled) {
          state.pendingApproval = null;
        } else {
          // Unrecognised shorthand — leave the approval pending and tell
          // the user how to answer.
          render.renderInfo("type a / allow, d / deny, or w / why?");
        }
      } else if (state.pendingQuestion) {
        const done = await handleAnswerStep(
          client,
          state.pendingQuestion,
          state,
          trimmed,
        );
        if (done) {
          // Hand control to the queue-drain / spinner-restart logic.
          clearActiveQuestion();
          // clearActiveQuestion already redrew either the next question or
          // the spinner — skip the bottom-of-handler prePrompt so we don't
          // double-render.
          return;
        }
      } else {
        const res = await client.request("chat.send", {
          sessionId: state.sessionId,
          content: trimmed,
        });
        if (res.status === "queued") {
          render.renderInfo(
            `queued at position ${res.queuePosition ?? "?"} — will send after the current run finishes`,
          );
        } else {
          activeRunId = res.runId;
          spinner.start();
          // Don't re-show the input until the run ends.
          return;
        }
      }
    } catch (err) {
      render.renderError(err instanceof Error ? err.message : String(err));
    }

    if (state.shouldExit) return;
    prePrompt();
  });

  prePrompt();

  // Wait until shouldExit is tripped.
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (state.shouldExit) {
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
  input.stop();
  client.close();
}

/**
 * Route an approval answer typed at the REPL prompt to `approvals.decide`.
 * Returns true if the line matched a known shortcut. `w` / `why` prints
 * the input again without deciding.
 */
async function handleApprovalAnswer(
  client: ProtocolClient,
  approval: ApprovalRecord,
  line: string,
): Promise<boolean> {
  const norm = line.toLowerCase().trim();
  if (norm === "a" || norm === "allow" || norm === "approve" || norm === "yes" || norm === "y") {
    await client.request("approvals.decide", {
      approvalId: approval.id,
      decision: "approve",
    });
    render.renderSuccess(`approved ${approval.toolName}`);
    return true;
  }
  if (norm === "d" || norm === "deny" || norm === "no" || norm === "n") {
    await client.request("approvals.decide", {
      approvalId: approval.id,
      decision: "deny",
    });
    render.renderInfo(`denied ${approval.toolName}`);
    return true;
  }
  if (norm === "w" || norm === "why" || norm === "?") {
    process.stdout.write(renderApprovalPrompt(approval));
    return true;
  }
  return false;
}

/**
 * Handle one line of input toward answering the active question record.
 * Walks the user through each sub-question in order; on the final
 * sub-question, submits all collected answers as a single
 * questions.answer request and returns true so the REPL can drain its
 * question queue. Returns false while more sub-questions remain so the
 * caller leaves pendingQuestion set and waits for the next line.
 *
 * Recognized inputs per sub-question:
 *   1, 2, 3, 4   → pick the corresponding option
 *   o, other     → arm the next line as a freeform answer
 *   anything else → freeform answer (taken verbatim)
 */
async function handleAnswerStep(
  client: ProtocolClient,
  question: QuestionRecord,
  state: {
    pendingSubIdx: number;
    pendingAnswers: Record<string, string>;
    awaitingFreeform: boolean;
  },
  line: string,
): Promise<boolean> {
  const subQs = question.input.questions;
  const sq = subQs[state.pendingSubIdx]!;

  let chosen: string | null = null;
  if (state.awaitingFreeform) {
    // Previous line said "other"; this one is the freeform answer.
    chosen = line;
    state.awaitingFreeform = false;
  } else {
    const norm = line.trim().toLowerCase();
    if (norm === "o" || norm === "other") {
      // Arm freeform mode and reprint the prompt so the user knows we're
      // waiting for a typed answer rather than a number.
      state.awaitingFreeform = true;
      render.renderInfo("type your answer:");
      return false;
    }
    const n = Number.parseInt(line, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= sq.options.length) {
      chosen = sq.options[n - 1]!.label;
    } else {
      // Anything else is a freeform answer — matches the dashboard's
      // "Other…" behavior, so power-users can skip the [o] step.
      chosen = line;
    }
  }

  state.pendingAnswers[sq.question] = chosen;
  state.pendingSubIdx += 1;

  if (state.pendingSubIdx < subQs.length) {
    // Reprint the panel with the next sub-question highlighted and
    // already-answered ones collapsed.
    process.stdout.write(
      render.renderAskPrompt(question, state.pendingSubIdx, state.pendingAnswers),
    );
    return false;
  }

  await client.request("questions.answer", {
    sessionId: question.sessionId,
    questionId: question.id,
    answers: { ...state.pendingAnswers },
  });
  return true;
}

async function refreshTaskCount(
  client: ProtocolClient,
  state: { sessionId: string; taskCount: number },
): Promise<void> {
  try {
    const { tasks } = await client.request("tasks.list", {
      sessionId: state.sessionId,
      includeDeleted: false,
    });
    state.taskCount = (tasks as Task[]).filter((t) => t.status !== "deleted").length;
  } catch {
    // Non-fatal.
  }
}

async function refreshOpenQuestions(
  client: ProtocolClient,
  state: { sessionId: string; openQuestions: number },
): Promise<void> {
  try {
    const { questions } = await client.request("questions.list", {
      sessionId: state.sessionId,
    });
    state.openQuestions = questions.length;
  } catch {
    // Non-fatal.
  }
}

async function refreshSessionTokens(
  client: ProtocolClient,
  state: { sessionId: string; tokensIn: number; tokensOut: number },
): Promise<void> {
  try {
    const { session } = await client.request("session.resume", {
      sessionId: state.sessionId,
    });
    state.tokensIn = session.tokensIn;
    state.tokensOut = session.tokensOut;
  } catch {
    // Non-fatal — statusbar just shows zeros until the next refresh.
  }
}

/**
 * Render the in-band approval prompt — `[a]llow / [d]eny / [w]hy?`. Shown
 * above the input row, like the ask-user prompt. The user types `a`, `d`,
 * or `w` (or the full word) on the next line; the line handler routes the
 * answer to `approvals.decide`.
 */
function renderApprovalPrompt(approval: ApprovalRecord): string {
  const accent = fg(roleColor("accent"));
  const muted = fg(roleColor("muted"));
  const warn = fg(roleColor("warn"));
  const tags = approval.tags.length > 0 ? approval.tags.join(", ") : "(no tags)";
  const head = color(`🔒 approval requested · ${approval.toolName}`, warn, C.BOLD);
  const sub = color(`tags: ${tags}`, muted);
  const choice = color(`[a]llow  [d]eny  [w]hy?`, accent, C.BOLD);
  const inputPreview = previewInput(approval.input);
  return [head, sub, color(inputPreview, muted), choice, ""].join("\n");
}

function previewInput(input: unknown): string {
  try {
    const json = JSON.stringify(input, null, 2);
    if (json.length <= 240) return json;
    return json.slice(0, 240) + "…";
  } catch {
    return "(unprintable input)";
  }
}
