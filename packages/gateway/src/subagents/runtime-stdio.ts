import { spawn } from "node:child_process";
import type {
  SubagentRuntime,
  SubagentRuntimeRunInput,
  SubagentRuntimeRunResult,
} from "./runtime.js";
import { logger as rootLogger } from "../logger.js";

const log = rootLogger.child({ component: "subagents.runtime-stdio" });

/**
 * Generic stdio runtime: spawns `command` with `args`, writes the prompt
 * onto stdin, streams stdout back as text deltas, returns the full
 * concatenated stdout as the result.
 *
 * This is the lowest-common-denominator ACP integration — appropriate for
 * agents that accept a single prompt on stdin and emit assistant output on
 * stdout. Real ACP servers do more (session state, tool round-trips), but
 * this is enough to delegate "do the thing and return the answer" tasks
 * to Claude Code / Codex / etc. configured in non-interactive mode.
 *
 * Plugins register this with arguments customized for the target CLI:
 *
 *   api.subagentRuntimes.register(
 *     stdioRuntime("acp-claude-code", "claude", ["chat", "--no-interactive"])
 *   )
 */
export interface StdioRuntimeOptions {
  command: string;
  args?: string[];
  /** Extra env vars merged with process.env. */
  env?: Record<string, string>;
  /**
   * If the runtime echoes the prompt back at the start of stdout, set this
   * to drop everything up to and including a marker line. Most CLIs don't
   * echo, so the default is "no trim".
   */
  trimUntilMarker?: string;
  /** Hard timeout — defaults to whatever the def sets, else 5min. */
  defaultTimeoutMs?: number;
}

export function stdioRuntime(id: string, opts: StdioRuntimeOptions): SubagentRuntime {
  return {
    id,
    async run(input: SubagentRuntimeRunInput): Promise<SubagentRuntimeRunResult> {
      const timeoutMs =
        input.definition.limits?.timeoutMs ?? opts.defaultTimeoutMs ?? 300_000;

      const child = spawn(opts.command, opts.args ?? [], {
        cwd: input.cwd,
        env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const onAbort = (): void => {
        log.info({ runtimeId: id, pid: child.pid }, "subagent runtime aborted (SIGTERM)");
        try {
          child.kill("SIGTERM");
        } catch (err) {
          log.debug({ err, runtimeId: id }, "subagent runtime: kill on abort failed (already exited?)");
        }
      };
      input.signal.addEventListener("abort", onAbort);

      let collected = "";
      let trimmed = !opts.trimUntilMarker;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!trimmed) {
          const idx = chunk.indexOf(opts.trimUntilMarker!);
          if (idx >= 0) {
            chunk = chunk.slice(idx + opts.trimUntilMarker!.length);
            trimmed = true;
          } else {
            return;
          }
        }
        collected += chunk;
        input.onTextChunk?.(chunk);
      });

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
      });

      try {
        child.stdin.end(input.prompt);
      } catch (err) {
        return {
          output: "",
          succeeded: false,
          inputTokens: 0,
          outputTokens: 0,
          detail: { error: err instanceof Error ? err.message : String(err) },
        };
      }

      const result = await new Promise<SubagentRuntimeRunResult>((resolve) => {
        const timer = setTimeout(() => {
          log.warn(
            { runtimeId: id, timeoutMs, pid: child.pid },
            "subagent runtime timed out — sending SIGTERM",
          );
          try {
            child.kill("SIGTERM");
          } catch (err) {
            log.debug({ err, runtimeId: id }, "subagent runtime: kill on timeout failed");
          }
          resolve({
            output: collected,
            succeeded: false,
            inputTokens: 0,
            outputTokens: 0,
            detail: { error: `runtime "${id}" timed out after ${timeoutMs}ms`, stderr },
          });
        }, timeoutMs);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({
            output: collected,
            succeeded: code === 0 && !signal,
            inputTokens: 0,
            outputTokens: 0,
            ...(code !== 0 || signal
              ? { detail: { code, signal, stderr } }
              : {}),
          });
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            output: collected,
            succeeded: false,
            inputTokens: 0,
            outputTokens: 0,
            detail: { error: err.message, stderr },
          });
        });
      });

      input.signal.removeEventListener("abort", onAbort);
      return result;
    },
  };
}
