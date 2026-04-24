import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { ProtocolClient } from "../protocol-client.js";
import * as render from "../render.js";
import { resolveEnv } from "../env.js";
import { getLastSessionId, setLastSessionId, clearLastSessionId } from "../session-store.js";
import { printWelcomeBanner, currentVersion } from "../ui/banner.js";
import { getRandomTip } from "../ui/tips.js";
import { brandString, roleColor } from "../ui/skin.js";
import { C, color, fg } from "../ui/colors.js";
import { renderStatusbar, isStatusbarEnabled } from "../ui/statusbar.js";
import { runSlash, commandNames } from "../ui/slash.js";
import { Spinner } from "../ui/spinner.js";
import type { Task, QuestionRecord } from "@squad/protocol";

const HISTORY_PATH = join(homedir(), ".squad", "history");
const HISTORY_MAX = 1000;

function loadHistory(): string[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
    // readline expects history most-recent-first.
    return lines.slice(-HISTORY_MAX).reverse();
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

/** Slash-command auto-completer. Only fires when the line starts with `/`. */
function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const stem = line.slice(1);
  const hits = commandNames()
    .filter((n) => n.startsWith(stem))
    .map((n) => "/" + n);
  return [hits, line];
}

/** Tiered Ctrl+C: first press cancels input, second within 2s exits. */
function installSigintHandling(
  rl: Interface,
  hooks: { onInterrupt: () => void; onExit: () => void },
): void {
  let lastAt = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastAt < 2000) {
      hooks.onExit();
      rl.close();
      return;
    }
    lastAt = now;
    hooks.onInterrupt();
    process.stdout.write(
      color("\n(ctrl-c again within 2s to exit)\n", fg(roleColor("muted"))),
    );
    rl.prompt(true);
  });
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

  // Track runs that already streamed deltas, so we don't double-render for
  // non-streaming providers that skip chat.text_delta and ship one big
  // chat.assistant_message.
  const streamedRuns = new Set<string>();

  // Spinner state. `activeRunId` is set from chat.send's response until the
  // matching assistant_message or error arrives. While set, we suppress the
  // REPL prompt and show an animated "thinking…" line instead.
  let activeRunId: string | null = null;
  const spinner = new Spinner("thinking");
  const stopSpinner = (): void => {
    if (activeRunId !== null) spinner.stop();
    activeRunId = null;
  };

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    historySize: HISTORY_MAX,
    prompt: promptString(),
    completer: (line: string) => slashCompleter(line),
  });
  // @ts-expect-error — readline exposes `history` as an internal array.
  rl.history = loadHistory();

  installSigintHandling(rl, {
    onInterrupt: () => {
      stopSpinner();
      render.endDeltaBlock();
    },
    onExit: () => {
      stopSpinner();
      process.stdout.write(
        `\n${color(brandString("goodbye", "see you."), fg(roleColor("accent")))}\n`,
      );
      state.shouldExit = true;
    },
  });

  client.onEvent((topic, data) => {
    if (topic.startsWith("chat.text_delta/")) {
      const d = data as { delta: string; runId?: string };
      if (d.runId) streamedRuns.add(d.runId);
      // First token arrived — drop the "thinking" spinner so text starts
      // rendering on a clean line.
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
      prePrompt();
    } else if (topic.startsWith("chat.tool_call/")) {
      const d = data as { name: string; input: unknown; runId?: string };
      // Live view: clear the spinner, print the tool call on its own line,
      // bump the spinner label to the running tool, restart beneath it. The
      // ⎿ result line lands under the call, building a call-tree as the
      // agent works.
      const underRun = activeRunId !== null && d.runId === activeRunId;
      if (underRun) spinner.stop();
      render.renderToolCallStart(d.name, d.input, state.verbose);
      if (underRun) {
        spinner.setLabel(`${d.name}`);
        spinner.start();
      }
    } else if (topic.startsWith("chat.tool_result/")) {
      const d = data as { runId?: string; result: unknown; isError?: boolean };
      const underRun = activeRunId !== null && d.runId === activeRunId;
      if (underRun) spinner.stop();
      render.renderToolResult(d.result, Boolean(d.isError));
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
      process.stdout.write(render.renderAskPrompt(state.pendingQuestion));
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
    // Don't show the prompt while a run is in flight — the spinner occupies
    // that line and would be clobbered by readline's redraw.
    if (activeRunId !== null) return;
    if (isStatusbarEnabled()) {
      renderStatusbar({
        sessionId: state.sessionId,
        pendingQuestion: Boolean(state.pendingQuestion),
        taskCount: state.taskCount,
        openQuestions: state.openQuestions,
      });
    }
    rl.setPrompt(promptString());
    rl.prompt(true);
  }

  prePrompt();

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) {
      prePrompt();
      return;
    }
    appendHistory(line);

    try {
      if (line.startsWith("/")) {
        await runSlash(line, { client, state });
      } else if (state.pendingQuestion) {
        await handleAnswer(client, state.pendingQuestion, line);
        state.pendingQuestion = null;
      } else {
        const res = await client.request("chat.send", {
          sessionId: state.sessionId,
          content: line,
        });
        // Start the spinner immediately. Event handlers (text_delta /
        // assistant_message / error) will stop it.
        if (res.status === "queued") {
          render.renderInfo(
            `queued at position ${res.queuePosition ?? "?"} — will send after the current run finishes`,
          );
        } else {
          activeRunId = res.runId;
          spinner.start();
        }
      }
    } catch (err) {
      render.renderError(err instanceof Error ? err.message : String(err));
    }

    if (state.shouldExit) {
      rl.close();
      return;
    }
    prePrompt();
  });

  await new Promise<void>((resolve) => {
    rl.once("close", () => resolve());
  });
  client.close();
}

async function handleAnswer(
  client: ProtocolClient,
  question: QuestionRecord,
  input: string,
): Promise<void> {
  const q = question.input.questions[0]!;
  let chosen: string;
  const n = Number.parseInt(input, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= q.options.length) {
    chosen = q.options[n - 1]!.label;
  } else {
    chosen = input;
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
