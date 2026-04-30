/**
 * RestartBackend — minimal interface the restart tool talks to.
 *
 * The gateway implements this against its in-process RestartManager. The tool
 * never imports the gateway directly. Tests stub it.
 */

export interface RestartScheduledResult {
  /** Echoes back to the agent so it knows the restart is in flight. */
  scheduled: true;
  /** Milliseconds until the gateway begins graceful shutdown. */
  delayMs: number;
  /** Free-text reason captured for logs and the broadcast event. */
  reason: string;
}

export interface RestartBackend {
  /**
   * Schedule a graceful restart. Resolves once the restart is committed
   * (the process is going to exit shortly), but BEFORE the actual exit so
   * the WS response carrying the tool result reaches the caller.
   *
   * Throws if the runtime can't guarantee a respawn (no supervisor +
   * no Docker restart policy detected) — callers must surface that error
   * to the agent rather than silently succeeding.
   *
   * Idempotent: a second call while a restart is already pending is a no-op
   * and returns the existing schedule.
   */
  requestRestart(input: { reason: string }): Promise<RestartScheduledResult>;
}
