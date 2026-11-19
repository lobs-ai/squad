/**
 * CodexHarness — drives @openai/codex-sdk as a HarnessSession.
 *
 * Resume-per-turn like the Claude adapter: each turn opens a Codex `Thread`
 * (fresh via `startThread`, or `resumeThread(id)` to continue), streams the
 * turn, and captures the thread id for the next turn.
 *
 * Phase-1 limitations (the documented "Codex is the rougher adapter"):
 *  - **No squad MCP primitives yet.** Codex reaches MCP servers via its CLI
 *    config (stdio/http), not in-process, so exposing squad primitives needs a
 *    served bridge (the claude-cli Unix-socket pattern). Until that lands,
 *    Codex runs with its native tools only; ask_user / tasks / reply / spawn
 *    are unavailable, so Codex is not yet suitable for channel turns.
 *  - **No system-prompt field.** Codex has no system-prompt option, so squad's
 *    appended prompt is folded into the first turn's input; it persists in the
 *    thread for resumed turns.
 *  - **No per-call approval** (`caps.perCallApproval = false`); approval is a
 *    coarse policy, set to "never" while approvals are deferred.
 */

import { Codex, type CodexOptions, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import type {
  ApprovalHook,
  HarnessCaps,
  HarnessEvent,
  HarnessFactory,
  HarnessSession,
  HarnessStartSpec,
  HarnessTurnInput,
} from "../types.js";
import { CodexNormalizer, type CdxEvent } from "./normalize.js";
import { buildCodexEnv } from "./env.js";

const CODEX_CAPS: HarnessCaps = {
  inProcessMcp: false,
  perCallApproval: false,
  thinking: true,
  resumeAcrossProcess: true,
};

class CodexHarness implements HarnessSession {
  readonly kind = "codex" as const;
  readonly caps = CODEX_CAPS;
  private hsid: string | undefined;
  private abort: AbortController | undefined;

  constructor(
    readonly sessionId: string,
    private readonly spec: HarnessStartSpec,
    _approval: ApprovalHook,
  ) {
    this.hsid = spec.resume;
  }

  async *runTurn(input: HarnessTurnInput): AsyncIterable<HarnessEvent> {
    const isFirst = !this.hsid;
    const opts: CodexOptions = {
      apiKey: this.spec.auth.token,
      env: buildCodexEnv(this.spec),
      ...(this.spec.auth.baseUrl ? { baseUrl: this.spec.auth.baseUrl } : {}),
    };
    const codex = new Codex(opts);
    const threadOptions: ThreadOptions = {
      model: this.spec.model,
      workingDirectory: this.spec.cwd,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };
    const thread: Thread = this.hsid
      ? codex.resumeThread(this.hsid, threadOptions)
      : codex.startThread(threadOptions);

    const text =
      isFirst && this.spec.appendSystemPrompt
        ? `${this.spec.appendSystemPrompt}\n\n---\n\n${input.text}`
        : input.text;

    this.abort = new AbortController();
    const norm = new CodexNormalizer();
    try {
      const { events } = await thread.runStreamed(text, { signal: this.abort.signal });
      for await (const ev of events) {
        for (const e of norm.next(ev as CdxEvent)) yield e;
      }
    } finally {
      const id = thread.id ?? norm.harnessSessionId();
      if (id) this.hsid = id;
      this.abort = undefined;
    }
  }

  harnessSessionId(): string | undefined {
    return this.hsid;
  }

  async interrupt(): Promise<void> {
    try {
      this.abort?.abort();
    } catch {
      /* best-effort */
    }
  }

  async close(): Promise<void> {
    /* no persistent process to tear down in resume-per-turn mode */
  }
}

export const codexHarnessFactory: HarnessFactory = {
  kind: "codex",
  async open(spec, approval): Promise<HarnessSession> {
    return new CodexHarness(spec.sessionId, spec, approval);
  },
};
