import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type {
  PromptPayload,
  RoutineRecord,
  ScriptPayload,
  ScriptThenPromptPayload,
} from "@squad/protocol";
import type { Logger } from "../logger.js";
import type { SessionStore } from "../db/sessions.js";
import type { MessageStore } from "../db/messages.js";
import type { ToolCallStore } from "../db/tool-calls.js";
import type { Broadcast } from "../broadcast.js";
import type { MemoryService } from "../memory/service.js";
import { runChatTurn } from "../runs.js";
import { appendRunLog, type CronPaths } from "./persistence.js";
import type { DeliveryRegistry } from "./delivery.js";

export interface ExecutorDeps {
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  toolRegistry: ToolRegistry;
  logger: Logger;
  workspaceDir: string;
  memory?: MemoryService;
  clientOverride?: LLMClient;
  /** Default model when a job's execution.model is unset. */
  defaultModel: string;
  /** Default fallbacks when execution.fallbacks is unset. */
  defaultFallbacks: string[];
  /** Filesystem paths for run-log persistence. */
  paths: CronPaths;
  /** Optional delivery fan-out — when omitted, fires are logged but not delivered. */
  delivery?: DeliveryRegistry;
}

export interface ExecutorResult {
  sessionId: string | null;
  status: "ok" | "error";
  error?: string;
}

const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_OUTPUT_CAP = 64 * 1024;

/**
 * Execute one routine. Routes by payload.kind:
 *   - prompt           → run via agent loop (runChatTurn)
 *   - script           → spawn child process, capture stdout/stderr
 *   - scriptThenPrompt → spawn script, then (on exit 0 + non-empty stdout)
 *                        feed stdout into the agent loop
 *
 * Routes by session.kind:
 *   - new       → fresh session created here
 *   - isolated  → fresh session with a synthetic parent flag (subagent-style)
 *   - session   → append to existing session
 *
 * Wake gates ([SILENT] / {wakeAgent:false}) are honored before delivery for
 * `script`. `scriptThenPrompt` uses the script's exit code as its conditional
 * — see runScriptThenPrompt for the rules.
 */
export class CronExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(rec: RoutineRecord): Promise<ExecutorResult> {
    const start = Date.now();
    const ts = new Date(start).toISOString();
    let result: ExecutorResult;
    let output: string | undefined;
    let payloadKind: RoutineRecord["payload"]["kind"];
    let tokens: { in: number; out: number } | undefined;
    let stpSkipped = false;

    try {
      if (rec.payload.kind === "script") {
        payloadKind = "script";
        const r = await this.runScript(rec.payload, rec);
        result = { sessionId: null, status: r.status, ...(r.error ? { error: r.error } : {}) };
        output = r.output;
      } else if (rec.payload.kind === "prompt") {
        payloadKind = "prompt";
        const r = await this.runAgent(rec, rec.payload);
        result = { sessionId: r.sessionId, status: r.status, ...(r.error ? { error: r.error } : {}) };
        output = r.output;
        tokens = r.tokens;
      } else if (rec.payload.kind === "scriptThenPrompt") {
        payloadKind = "scriptThenPrompt";
        const r = await this.runScriptThenPrompt(rec);
        result = {
          sessionId: r.sessionId,
          status: r.status,
          ...(r.error ? { error: r.error } : {}),
        };
        output = r.output;
        tokens = r.tokens;
        stpSkipped = r.skipped;
      } else {
        // Should be unreachable thanks to zod, but TS narrowing demands it.
        throw new Error(`unknown payload kind: ${(rec.payload as { kind: string }).kind}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err, routineId: rec.id }, "cron executor threw");
      result = { sessionId: null, status: "error", error: msg };
      payloadKind = rec.payload.kind;
    }

    const durationMs = Date.now() - start;

    // Wake-gate (script): exit-0 + body of `{"wakeAgent":false}` is treated
    // as "nothing happened" — status flips to skipped, delivery suppressed.
    const trimmedAll = (output ?? "").trim();
    if (
      payloadKind === "script" &&
      result.status === "ok" &&
      isWakeAgentFalseJson(trimmedAll)
    ) {
      result = { sessionId: null, status: "ok" };
      appendRunLog(this.deps.paths.runs, rec.id, {
        ts,
        status: "skipped",
        durationMs,
        payloadKind,
        ...(output !== undefined ? { output: output.slice(0, SCRIPT_OUTPUT_CAP) } : {}),
        delivery: { kind: rec.delivery.kind, ok: true, error: "wake-gate-noop" },
      });
      // Surface "skipped" up to markFired so the row reflects it.
      return { sessionId: null, status: "ok", error: "wake-gate-noop" };
    }

    // Wake-gate (any payload): first line `[SILENT]` suppresses delivery
    // but keeps the run logged with its real status.
    const silent = trimmedAll.startsWith("[SILENT]");

    // scriptThenPrompt's "nothing to do" path: skipped status, no delivery.
    if (stpSkipped) {
      appendRunLog(this.deps.paths.runs, rec.id, {
        ts,
        status: "skipped",
        durationMs,
        payloadKind,
        ...(output !== undefined ? { output: output.slice(0, SCRIPT_OUTPUT_CAP) } : {}),
        delivery: { kind: rec.delivery.kind, ok: true, error: "scriptThenPrompt-noop" },
      });
      return { sessionId: null, status: "ok", error: "scriptThenPrompt-noop" };
    }

    let deliveryReport: { kind: string; ok: boolean; error?: string } | undefined;
    if (this.deps.delivery && result.status === "ok") {
      deliveryReport = {
        kind: rec.delivery.kind,
        ...(await this.deps.delivery.dispatch({
          routineId: rec.id,
          routineName: rec.name,
          delivery: rec.delivery,
          runId: `cron_${rec.id}`,
          sessionId: result.sessionId,
          payloadKind,
          ...(output !== undefined ? { output } : {}),
          ...(tokens ? { tokens } : {}),
          silentGate: silent,
        })),
      };
    } else if (silent) {
      deliveryReport = { kind: rec.delivery.kind, ok: true, error: "wake-gate-silent" };
    }

    appendRunLog(this.deps.paths.runs, rec.id, {
      ts,
      status: result.status,
      durationMs,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      payloadKind,
      ...(output !== undefined ? { output: output.slice(0, SCRIPT_OUTPUT_CAP) } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(tokens ? { tokens } : {}),
      ...(deliveryReport ? { delivery: deliveryReport } : {}),
    });

    return result;
  }

  // ---- payload routing ------------------------------------------------

  private async runAgent(
    rec: RoutineRecord,
    body: PromptPayload | ScriptThenPromptPayload["prompt"],
    extraUserText?: string,
  ): Promise<{
    sessionId: string;
    status: "ok" | "error";
    error?: string;
    output?: string;
    tokens?: { in: number; out: number };
  }> {
    const sessionId = await this.resolveSessionId(rec);
    const userText = composeUserText(body.messages, extraUserText);
    const systemPromptOverride = composeSystemPrompt(body.messages, body.skills);
    const runId = `cron_${rec.id}_${randomUUID().slice(0, 8)}`;
    const toolReg = this.scopeToolRegistry(rec);

    try {
      const turn = await runChatTurn(
        {
          sessionId,
          cwd: this.deps.workspaceDir,
          runId,
          userContent: [{ type: "text", text: userText }],
          persistUserMessage: true,
          model: rec.execution.model ?? this.deps.defaultModel,
          fallbacks: rec.execution.fallbacks ?? this.deps.defaultFallbacks,
          toolRegistry: toolReg,
          ...(rec.execution.toolsAllow && rec.execution.toolsAllow.length > 0
            ? { toolsAllow: rec.execution.toolsAllow }
            : {}),
          ...(systemPromptOverride ? { systemPrompt: systemPromptOverride } : {}),
          ...(this.deps.clientOverride ? { clientOverride: this.deps.clientOverride } : {}),
        },
        {
          sessions: this.deps.sessions,
          messages: this.deps.messages,
          toolCalls: this.deps.toolCalls,
          broadcast: this.deps.broadcast,
          logger: this.deps.logger,
          ...(this.deps.memory ? { memory: this.deps.memory } : {}),
        },
      );
      return {
        sessionId,
        status: "ok",
        output: turn.result.output,
        tokens: { in: turn.result.usage.inputTokens, out: turn.result.usage.outputTokens },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { sessionId, status: "error", error: msg };
    }
  }

  private async runScript(
    payload: ScriptPayload | ScriptThenPromptPayload,
    rec: RoutineRecord,
  ): Promise<{
    status: "ok" | "error";
    error?: string;
    output: string;
    exitCode: number | null;
  }> {
    const { command, args = [], cwd } = payload;
    const timeoutMs = (rec.execution.timeoutSec ?? 300) * 1000;
    const effectiveTimeout = Math.min(timeoutMs, SCRIPT_TIMEOUT_MS);

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: cwd ?? this.deps.workspaceDir,
        env: process.env,
      });
      let out = "";
      let cap = SCRIPT_OUTPUT_CAP;
      const append = (chunk: Buffer): void => {
        if (cap <= 0) return;
        const s = chunk.toString("utf8");
        const slice = s.slice(0, cap);
        out += slice;
        cap -= slice.length;
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, effectiveTimeout);

      child.on("error", (err) => {
        clearTimeout(killer);
        resolve({ status: "error", error: err.message, output: out, exitCode: null });
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (code === 0) {
          resolve({ status: "ok", output: out, exitCode: code });
        } else {
          resolve({
            status: "error",
            error: `exit code ${code}`,
            output: out,
            exitCode: code,
          });
        }
      });
    });
  }

  /**
   * scriptThenPrompt: spawn the script, then conditionally hand its stdout
   * to the agent loop based on the script's exit code.
   *
   * Rules:
   *   - exit 0, non-empty stdout  → run the agent. {{output}} placeholders
   *                                 in any prompt message are substituted;
   *                                 if no message has the placeholder, the
   *                                 stdout is appended as a final user message.
   *   - exit 0, empty stdout      → skipped (the "nothing to do" path).
   *   - non-zero exit             → status=error, no agent run.
   */
  private async runScriptThenPrompt(rec: RoutineRecord): Promise<{
    sessionId: string | null;
    status: "ok" | "error";
    error?: string;
    output?: string;
    tokens?: { in: number; out: number };
    skipped: boolean;
  }> {
    if (rec.payload.kind !== "scriptThenPrompt") {
      throw new Error("not a scriptThenPrompt payload");
    }
    const payload = rec.payload;
    const scriptResult = await this.runScript(payload, rec);
    if (scriptResult.status === "error") {
      return {
        sessionId: null,
        status: "error",
        ...(scriptResult.error ? { error: scriptResult.error } : {}),
        output: scriptResult.output,
        skipped: false,
      };
    }
    const stdout = scriptResult.output;
    if (stdout.trim().length === 0) {
      return { sessionId: null, status: "ok", output: stdout, skipped: true };
    }

    const substituted = substituteOutputPlaceholder(payload.prompt.messages, stdout);
    const matched = substituted.changed;
    const promptBody: PromptPayload = {
      kind: "prompt",
      messages: substituted.messages,
      ...(payload.prompt.skills ? { skills: payload.prompt.skills } : {}),
    };

    const r = await this.runAgent(rec, promptBody, matched ? undefined : stdout);
    return {
      sessionId: r.sessionId,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      output: r.output,
      ...(r.tokens ? { tokens: r.tokens } : {}),
      skipped: false,
    };
  }

  // ---- session resolution --------------------------------------------

  private async resolveSessionId(rec: RoutineRecord): Promise<string> {
    if (rec.session.kind === "session") {
      const existing = this.deps.sessions.tryGet(rec.session.sessionId);
      if (!existing) {
        throw new Error(`cron job ${rec.id} targets unknown session ${rec.session.sessionId}`);
      }
      return existing.id;
    }
    const session = this.deps.sessions.create({
      title: `routine:${rec.name}`,
      model: rec.execution.model ?? this.deps.defaultModel,
      fallbacks: rec.execution.fallbacks ?? this.deps.defaultFallbacks,
      // Isolated sessions get no parent and a synthetic subagent_def_id so
      // they don't show up as top-level chat sessions in the dashboard.
      ...(rec.session.kind === "isolated" ? { subagentDefId: `cron:${rec.id}` } : {}),
    });
    return session.id;
  }

  // ---- payload helpers -----------------------------------------------

  private scopeToolRegistry(_rec: RoutineRecord): ToolRegistry {
    // Filtering happens via runChatTurn's `toolsAllow` — the full registry
    // is still passed in so tool execution itself can find the executor.
    return this.deps.toolRegistry;
  }
}

/**
 * Concatenate user-role messages into a single user-turn text. If the
 * caller has extra text (e.g. the script's stdout in scriptThenPrompt with
 * no `{{output}}` placeholder), it is appended after a separator.
 */
function composeUserText(
  messages: Array<{ role: "user" | "system"; text: string }>,
  extraUserText?: string,
): string {
  const userParts = messages.filter((m) => m.role === "user").map((m) => m.text);
  if (extraUserText !== undefined) userParts.push(extraUserText);
  return userParts.join("\n\n");
}

/**
 * Build a system-prompt override from any system messages plus an optional
 * Skills hint. Returns undefined when there's nothing to add.
 */
function composeSystemPrompt(
  messages: Array<{ role: "user" | "system"; text: string }>,
  skills: string[] | undefined,
): string | undefined {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" && m.text.length > 0) parts.push(m.text);
  }
  if (skills && skills.length > 0) {
    parts.push(`Skills enabled for this routine: ${skills.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Replace every `{{output}}` placeholder (whitespace-tolerant) with the
 * script's stdout. Returns whether any message actually changed — the
 * caller uses this to decide whether to append stdout as a fallback final
 * user message.
 */
function substituteOutputPlaceholder(
  messages: Array<{ role: "user" | "system"; text: string }>,
  stdout: string,
): {
  messages: Array<{ role: "user" | "system"; text: string }>;
  changed: boolean;
} {
  let changed = false;
  const next = messages.map((m) => {
    const replaced = m.text.replace(/\{\{\s*output\s*\}\}/g, stdout);
    if (replaced === m.text) return m;
    changed = true;
    return { ...m, text: replaced };
  });
  return { messages: next, changed };
}

/**
 * Recognise `{"wakeAgent": false}` (whitespace-tolerant) anywhere in a
 * script's stdout. Honored only when the script exits 0 — the caller does
 * the exit-code check.
 */
function isWakeAgentFalseJson(text: string): boolean {
  if (!text) return false;
  const candidates = text.split(/\r?\n/).filter(Boolean);
  candidates.push(text);
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { wakeAgent?: unknown };
      if (parsed && typeof parsed === "object" && parsed.wakeAgent === false) return true;
    } catch {
      // try the next line
    }
  }
  return false;
}
