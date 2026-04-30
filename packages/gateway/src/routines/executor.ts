import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { RoutineRecord } from "@squad/protocol";
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
 *   - prompt    → run via agent loop (runChatTurn)
 *   - agentTurn → like prompt but with explicit messages
 *   - script    → spawn child process, capture stdout/stderr
 *
 * Routes by session.kind:
 *   - new       → fresh session created here
 *   - isolated  → fresh session with a synthetic parent flag (subagent-style)
 *   - session   → append to existing session
 *
 * Wake gates ([SILENT] / {wakeAgent:false}) are honored before delivery.
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

    try {
      if (rec.payload.kind === "script") {
        payloadKind = "script";
        const r = await this.runScript(rec);
        result = { sessionId: null, status: r.status, ...(r.error ? { error: r.error } : {}) };
        output = r.output;
      } else if (rec.payload.kind === "prompt" || rec.payload.kind === "agentTurn") {
        payloadKind = rec.payload.kind;
        const r = await this.runAgent(rec);
        result = { sessionId: r.sessionId, status: r.status, ...(r.error ? { error: r.error } : {}) };
        output = r.output;
        tokens = r.tokens;
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

  private async runAgent(rec: RoutineRecord): Promise<{
    sessionId: string;
    status: "ok" | "error";
    error?: string;
    output?: string;
    tokens?: { in: number; out: number };
  }> {
    const sessionId = await this.resolveSessionId(rec);
    const userText = this.payloadToUserText(rec);
    const systemPromptOverride = this.payloadToSystemPrompt(rec);
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

  private async runScript(rec: RoutineRecord): Promise<{
    status: "ok" | "error";
    error?: string;
    output: string;
  }> {
    if (rec.payload.kind !== "script") throw new Error("not a script payload");
    const { command, args = [], cwd } = rec.payload;
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
        resolve({ status: "error", error: err.message, output: out });
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (code === 0) {
          resolve({ status: "ok", output: out });
        } else {
          resolve({ status: "error", error: `exit code ${code}`, output: out });
        }
      });
    });
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

  private payloadToUserText(rec: RoutineRecord): string {
    if (rec.payload.kind === "prompt") return rec.payload.text;
    if (rec.payload.kind === "agentTurn") {
      // Concatenate non-system messages — system messages are folded into
      // the system prompt override.
      return rec.payload.messages
        .filter((m) => m.role === "user")
        .map((m) => m.text)
        .join("\n\n");
    }
    return "";
  }

  private payloadToSystemPrompt(rec: RoutineRecord): string | undefined {
    if (rec.payload.kind === "agentTurn") {
      const sys = rec.payload.messages
        .filter((m) => m.role === "system")
        .map((m) => m.text)
        .join("\n\n");
      return sys.length > 0 ? sys : undefined;
    }
    if (rec.payload.kind === "prompt" && rec.payload.skills && rec.payload.skills.length > 0) {
      return `Skills enabled for this routine: ${rec.payload.skills.join(", ")}`;
    }
    return undefined;
  }

  private scopeToolRegistry(_rec: RoutineRecord): ToolRegistry {
    // Filtering happens via runChatTurn's `toolsAllow` — the full registry
    // is still passed in so tool execution itself can find the executor.
    return this.deps.toolRegistry;
  }
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
