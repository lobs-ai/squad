/**
 * Supervisor — parent process that spawns the gateway as a child and respawns
 * it on a graceful "please restart me" exit (`SQUAD_RESTART_EXIT_CODE = 75`).
 *
 * Why this exists:
 *   The agent has a `restart_gateway` tool. For that tool to be safe, *something*
 *   has to bring the process back when it exits. Docker's restart policy covers
 *   container deployments, but breaks for `pnpm start`, `node dist/bin.js`,
 *   systemd-without-Restart=, etc. This supervisor closes the gap with a
 *   tiny in-process layer: it forks itself with `SQUAD_SUPERVISED=1`, waits
 *   for the child, and respawns on code 75.
 *
 * Loop guard:
 *   If the child exits with code 75 more than `MAX_RAPID_RESTARTS` times
 *   within `RESTART_WINDOW_MS`, the supervisor gives up with a non-zero exit
 *   so the orchestrator (Docker / systemd / a human) can intervene. This
 *   prevents a stuck agent from chewing CPU in a respawn loop.
 *
 * Signals:
 *   SIGTERM/SIGINT received by the supervisor are forwarded to the child.
 *   Once the child exits, the supervisor exits with the child's code (or 128+sig
 *   if the child died from a signal).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../logger.js";
import { SQUAD_RESTART_EXIT_CODE } from "./manager.js";

const MAX_RAPID_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const RESPAWN_BACKOFF_MS = 500;

export interface SupervisorOptions {
  /** Path to the worker entry — usually `process.argv[1]` (this same file). */
  entry: string;
  /** Args forwarded to the child (defaults to `process.argv.slice(2)`). */
  args?: string[];
  /** Override `process.execPath` (tests). */
  execPath?: string;
  /** Override `process.env` (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override `child_process.spawn` (tests). */
  spawnFn?: typeof spawn;
  /** Test seam: called instead of `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam: called for SIGINT/SIGTERM hookup. */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Test seam: pause function. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run as supervisor: spawn child gateway, respawn on code 75, propagate signals.
 *
 * Returns when the child has exited and the supervisor is done. Most callers
 * pass `process.exit` as `opts.exit` so the function never returns in
 * production; tests use the return value.
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<void> {
  const execPath = opts.execPath ?? process.execPath;
  const args = opts.args ?? process.argv.slice(2);
  const baseEnv = opts.env ?? process.env;
  const spawnFn = opts.spawnFn ?? spawn;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const sleep = opts.sleep ?? defaultSleep;
  const onSignal =
    opts.onSignal ??
    ((sig, handler) => {
      process.on(sig, handler);
    });

  const restartTimes: number[] = [];
  let current: ChildProcess | null = null;
  let shuttingDown = false;
  let pendingSignal: NodeJS.Signals | null = null;

  const forwardSignal = (sig: NodeJS.Signals): void => {
    shuttingDown = true;
    pendingSignal = sig;
    if (current && !current.killed) {
      logger.info({ signal: sig }, "supervisor forwarding signal to gateway");
      current.kill(sig);
    }
  };

  onSignal("SIGINT", () => forwardSignal("SIGINT"));
  onSignal("SIGTERM", () => forwardSignal("SIGTERM"));

  for (;;) {
    const child = spawnFn(execPath, [opts.entry, ...args], {
      stdio: "inherit",
      env: { ...baseEnv, SQUAD_SUPERVISED: "1" },
    });
    current = child;

    const { code, signal } = await waitForExit(child);
    current = null;

    if (shuttingDown) {
      // Operator-driven shutdown — never respawn. Exit with the right code.
      if (signal) {
        logger.info({ signal }, "supervisor exiting after signal");
        exit(128 + signalNumber(signal));
        return;
      }
      logger.info({ code }, "supervisor exiting");
      exit(code ?? 0);
      return;
    }

    if (code === SQUAD_RESTART_EXIT_CODE) {
      const now = Date.now();
      restartTimes.push(now);
      while (restartTimes.length > 0 && now - restartTimes[0]! > RESTART_WINDOW_MS) {
        restartTimes.shift();
      }
      if (restartTimes.length > MAX_RAPID_RESTARTS) {
        logger.fatal(
          { restartsInWindow: restartTimes.length, windowMs: RESTART_WINDOW_MS },
          "gateway restart loop detected — supervisor giving up",
        );
        exit(1);
        return;
      }
      logger.warn(
        { restartCount: restartTimes.length },
        "gateway exited with restart code — respawning",
      );
      await sleep(RESPAWN_BACKOFF_MS);
      continue;
    }

    // Any other exit is terminal — propagate it.
    if (signal) {
      logger.warn({ signal }, "gateway died from signal — supervisor exiting");
      exit(128 + signalNumber(signal));
      return;
    }
    logger.info({ code }, "gateway exited — supervisor exiting");
    exit(code ?? 0);
    return;
  }

  // Unreachable: the loop only exits via `return`. `pendingSignal` is read
  // for symmetry; eslint-disable to keep the variable around for future hooks.
  void pendingSignal;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function signalNumber(sig: NodeJS.Signals): number {
  // Common cases. Anything we don't know maps to 15 (SIGTERM-equivalent).
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return map[sig] ?? 15;
}
