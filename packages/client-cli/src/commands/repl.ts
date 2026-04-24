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
import type { Task, QuestionRecord } from "@squad/protocol";

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
      const { session } = await client.request("session.start", { title: "cli" });
      sessionId = session.id;
    }
  } else {
    const { session } = await client.request("session.start", { title: "cli" });
    sessionId = session.id;
  }
  setLastSessionId(sessionId);

  const subscribedTopics = (sid: string): string[] => [
    `chat.*/${sid}`,
    `tasks.*/${sid}`,
    `questions.*/${sid}`,
  ];

  // Mutable state shared with slash handlers.
  const state = {
    sessionId,
    verbose: "compact" as import("../ui/render.js").VerboseLevel,
    shouldExit: false,
    pendingQuestion: null as QuestionRecord | null,
    taskCount: 0,
    openQuestions: 0,
    onSessionChange: async (newId: string) => {
      try {
        await client.unsubscribe(subscribedTopics(state.sessionId));
      } catch {
        // ignore — stale subs are harmless
      }
      state.sessionId = newId;
      setLastSessionId(newId);
      await client.subscribe(subscribedTopics(newId));
      await refreshTaskCount(client, state);
      await refreshOpenQuestions(client, state);
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
