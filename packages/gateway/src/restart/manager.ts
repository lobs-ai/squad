/**
 * RestartManager — schedules a graceful gateway restart in response to an
 * agent tool call (or admin RPC, eventually).
 *
 * The "complete fully" guarantee splits in two:
 *
 *   1. We refuse to schedule a restart unless the runtime can guarantee a
 *      respawn — either we were spawned by `supervisor.ts` (env
 *      `SQUAD_SUPERVISED=1`), or we're running inside Docker with a restart
 *      policy (`SQUAD_RESTART_POLICY=docker`, set by mgr's compose
 *      generator). Without one of those, the tool errors out instead of
 *      exiting and stranding the user.
 *
 *   2. The shutdown is deferred ~750ms so the WS frame carrying the tool
 *      result reaches the caller before we close the listener. We also
 *      broadcast `gateway.restarting` so dashboards can show a banner.
 *
 * The exit code 75 (`SQUAD_RESTART_EXIT_CODE`) is the agreed-upon "respawn me"
 * signal between this process and the supervisor. Other exit codes propagate
 * up (the supervisor exits with the same code).
 */

import type { Logger } from "../logger.js";
import type { Broadcast } from "../broadcast.js";
import type { RestartBackend, RestartScheduledResult } from "@squad/tools";

export const SQUAD_RESTART_EXIT_CODE = 75;
const DEFAULT_DELAY_MS = 750;

/** Reasons a restart can't be safely scheduled. */
export class RestartUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartUnsupportedError";
  }
}

export interface RestartManagerOptions {
  logger: Logger;
  broadcast: Broadcast;
  /** Called after the broadcast + delay to flush state. Typically `boot.close`. */
  close: () => Promise<void>;
  /** Test seam — defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam — defaults to a wall-clock setTimeout. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** Test seam — defaults to reading `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam — override the standard 750ms grace period. */
  delayMs?: number;
}

/**
 * Returns `null` if the runtime can guarantee respawn; otherwise an
 * explanation of *why* it can't.
 *
 * Two "yes" signals:
 *   - `SQUAD_SUPERVISED=1`: set by the supervisor in bin.ts when it forked us.
 *   - `SQUAD_RESTART_POLICY=<any non-empty>`: an external supervisor (Docker
 *     `restart: unless-stopped`, systemd `Restart=always`, k8s, …) is
 *     responsible for respawning the process. The value is informational.
 */
export function detectRespawnGuarantee(env: NodeJS.ProcessEnv): null | string {
  if (env["SQUAD_SUPERVISED"] === "1") return null;
  const policy = env["SQUAD_RESTART_POLICY"];
  if (typeof policy === "string" && policy.trim().length > 0) return null;
  return [
    "no respawn guarantee detected",
    "(neither SQUAD_SUPERVISED=1 nor SQUAD_RESTART_POLICY is set).",
    "Run via the supervised entrypoint (`pnpm start`, `docker compose up`)",
    "or ask the user to restart manually.",
  ].join(" ");
}

interface PendingRestart {
  reason: string;
  scheduledAt: number;
  delayMs: number;
}

export class RestartManager implements RestartBackend {
  private pending: PendingRestart | null = null;
  private readonly opts: RestartManagerOptions;

  constructor(opts: RestartManagerOptions) {
    this.opts = opts;
  }

  /** Currently scheduled restart, or null. */
  get pendingRestart(): Readonly<PendingRestart> | null {
    return this.pending;
  }

  async requestRestart(input: { reason: string }): Promise<RestartScheduledResult> {
    const env = this.opts.env ?? process.env;
    const blocker = detectRespawnGuarantee(env);
    if (blocker) {
      throw new RestartUnsupportedError(blocker);
    }

    const reason = input.reason || "agent-requested restart";
    const delayMs = this.opts.delayMs ?? DEFAULT_DELAY_MS;

    if (this.pending) {
      // Idempotent: already scheduled. Return the existing schedule.
      this.opts.logger.info(
        { reason, existingReason: this.pending.reason },
        "restart already scheduled — coalescing",
      );
      return {
        scheduled: true,
        delayMs: this.pending.delayMs,
        reason: this.pending.reason,
      };
    }

    this.pending = { reason, scheduledAt: Date.now(), delayMs };
    this.opts.logger.warn({ reason, delayMs }, "gateway restart scheduled");

    // Tell the world the restart is coming. Dashboards can show a banner;
    // CLI clients can prepare to reconnect.
    try {
      this.opts.broadcast.publish("gateway.restarting", {
        reason,
        delayMs,
        scheduledAt: this.pending.scheduledAt,
      });
    } catch (err) {
      this.opts.logger.error({ err }, "failed to broadcast gateway.restarting");
    }

    const timer = this.opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    timer(() => {
      void this.executeShutdown();
    }, delayMs);

    return { scheduled: true, delayMs, reason };
  }

  private async executeShutdown(): Promise<void> {
    const exit = this.opts.exit ?? ((code: number) => process.exit(code));
    try {
      this.opts.logger.info("gateway closing for restart");
      await this.opts.close();
    } catch (err) {
      this.opts.logger.error({ err }, "graceful close failed during restart — forcing exit");
    } finally {
      exit(SQUAD_RESTART_EXIT_CODE);
    }
  }
}
