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
      state.pendingQuestion = (data as { question: QuestionRecord }).question;
      state.openQuestions = (state.openQuestions ?? 0) + 1;
      printSafely(() => process.stdout.write(render.renderAskPrompt(state.pendingQuestion!)));
      prePrompt();
    } else if (
      topic.startsWith("questions.answered/") ||
      topic.startsWith("questions.cancelled/") ||
      topic.startsWith("questions.timed_out/")
    ) {
      state.pendingQuestion = null;
      state.openQuestions = Math.max(0, (state.openQuestions ?? 1) - 1);
    } else if (
      topic.startsWith("approvals.requested/") ||
      topic.startsWith("approvals.pending/")
    ) {
      const approval = (data as { approval: ApprovalRecord }).approval;
      // Coalesce the two events: `pending` and `requested` fire together.
      if (state.pendingApproval?.id === approval.id) return;
      state.pendingApproval = approval;
      state.pendingApprovals += 1;
      printSafely(() => {
        process.stdout.write(renderApprovalPrompt(approval));
      });
      prePrompt();
    } else if (topic.startsWith("approvals.decided/")) {
      const approval = (data as { approval: ApprovalRecord }).approval;
      if (state.pendingApproval?.id === approval.id) {
        state.pendingApproval = null;
      }
      state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
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

  function prePrompt(): void {
    if (state.shouldExit) return;
    if (activeRunId !== null) return;
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
        await handleAnswer(client, state.pendingQuestion, trimmed);
        state.pendingQuestion = null;
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

async function handleAnswer(
  client: ProtocolClient,
  question: QuestionRecord,
  line: string,
): Promise<void> {
  const q = question.input.questions[0]!;
  let chosen: string;
  const n = Number.parseInt(line, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= q.options.length) {
    chosen = q.options[n - 1]!.label;
  } else {
    chosen = line;
  }
  await client.request("questions.answer", {
    sessionId: question.sessionId,
    questionId: question.id,
    answers: { [q.question]: chosen },
  });
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
