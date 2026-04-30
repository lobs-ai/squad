import type { Logger } from "../logger.js";
import type { RoutineRecord, Schedule } from "@squad/protocol";
import type { RoutineStore } from "./store.js";
import { staggerOffsetMs, tryAcquireTickLock, type CronPaths } from "./persistence.js";

/**
 * Tiny cron tick. Runs once per `tickMs` (default 60s), fires any job whose
 * `nextRunAt` is in the past. Computes `nextRunAt` *before* invoking the
 * runner so a crash mid-run cannot re-fire on next boot (at-most-once).
 *
 * Schedule semantics:
 *   - cron: minute-granularity expression, optional staggerMs added to the
 *     matched minute via deterministic hash of jobId.
 *   - interval: everyMs since `anchor` (or job creation time).
 *   - once:    fires at `at`, then disables the job.
 */
export interface ScheduleOptions {
  tickMs?: number;
  now?: () => Date;
  /** Stagger seed — typically gateway instance name or hostname. */
  staggerSeed?: string;
  /** Override the default thread-pool concurrency (4). */
  maxParallel?: number;
  /** Filesystem paths for advisory tick lock. Tests skip the lock. */
  paths?: CronPaths | null;
}

export interface SchedulerRunner {
  (job: RoutineRecord): Promise<{ sessionId: string | null; status: "ok" | "error"; error?: string }>;
}

export class RoutineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight: Set<string> = new Set();
  private readonly opts: ScheduleOptions;

  constructor(
    private readonly store: RoutineStore,
    private readonly runJob: SchedulerRunner,
    private readonly logger: Logger,
    opts: ScheduleOptions = {},
  ) {
    this.opts = opts;
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? 60_000;
    // Recompute `nextRunAt` for every job that doesn't have one — covers
    // a fresh boot or a job that was created without a schedule fire pass.
    this.primeNextRunTimes();
    this.timer = setInterval(() => this.tick(), tickMs);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Test seam: run one tick deterministically. */
  tickOnce(): void {
    this.tick();
  }

  // ---- private --------------------------------------------------------

  private primeNextRunTimes(): void {
    const now = this.now();
    for (const rec of this.store.list()) {
      if (!rec.enabled) continue;
      if (rec.nextRunAt) continue;
      const next = computeNextRunAt(rec.schedule, now, this.staggerSeed());
      if (next) this.store.setState(rec.id, { nextRunAt: next.toISOString() });
    }
  }

  private tick(): void {
    const release = this.opts.paths
      ? tryAcquireTickLock(this.opts.paths.tickLock)
      : (() => () => undefined)();
    if (!release) {
      // Another tick is running. Skip cleanly.
      return;
    }
    try {
      this.tickInner();
    } finally {
      release();
    }
  }

  private tickInner(): void {
    const now = this.now();
    const maxParallel = this.opts.maxParallel ?? 4;
    let started = 0;
    for (const rec of this.store.list()) {
      if (!rec.enabled) continue;
      if (this.inFlight.has(rec.id)) continue;
      if (started >= maxParallel) break;

      const due = isDue(rec, now, this.staggerSeed());
      if (due === "not_due") continue;

      // Advance before execute. For "once" jobs we also disable.
      const nextRun = computeNextRunAt(rec.schedule, now, this.staggerSeed());
      this.store.setState(rec.id, { nextRunAt: nextRun ? nextRun.toISOString() : null });
      if (rec.schedule.kind === "once") {
        this.store.update({ id: rec.id, enabled: false });
      }

      if (due === "skip_stale") {
        // Past grace — recompute and skip the run, log as skipped.
        this.store.markFired(rec.id, null, "skipped", now.toISOString(), "missed-window");
        continue;
      }

      this.inFlight.add(rec.id);
      started += 1;
      void this.fire(rec);
    }
  }

  private async fire(rec: RoutineRecord): Promise<void> {
    try {
      const result = await this.runJob(rec);
      this.store.markFired(
        rec.id,
        result.sessionId,
        result.status,
        new Date().toISOString(),
        result.error ?? null,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, routine: rec.name }, "routine threw");
      this.store.markFired(rec.id, null, "error", new Date().toISOString(), msg);
    } finally {
      this.inFlight.delete(rec.id);
    }
  }

  private staggerSeed(): string {
    return this.opts.staggerSeed ?? "squad";
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }
}

// -- Schedule math (pure, exported for tests) ------------------------------

const ONCE_GRACE_MS = 120_000;
const MIN_GRACE_MS = 120_000;
const MAX_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Decide whether a job should fire on this tick.
 *  - "fire"        → run it, then advance nextRunAt.
 *  - "skip_stale"  → past grace; advance nextRunAt without running.
 *  - "not_due"     → leave alone.
 */
export function isDue(
  rec: RoutineRecord,
  now: Date,
  seed: string,
): "fire" | "skip_stale" | "not_due" {
  void seed;
  const next = rec.nextRunAt ? new Date(rec.nextRunAt) : null;
  if (!next) return "not_due";
  const diff = now.getTime() - next.getTime();
  if (diff < 0) return "not_due";
  const grace = graceWindowMs(rec.schedule);
  if (diff > grace) return "skip_stale";
  return "fire";
}

function graceWindowMs(s: Schedule): number {
  if (s.kind === "once") return ONCE_GRACE_MS;
  if (s.kind === "interval") {
    return clamp(s.everyMs / 2, MIN_GRACE_MS, MAX_GRACE_MS);
  }
  // cron: assume the "period" is the smallest gap implied by the expression.
  // Cheap heuristic — for "*/N" minute step we get N minutes; otherwise
  // assume hourly. Conservative; over-generous grace is fine.
  const parts = s.expr.trim().split(/\s+/);
  if (parts[0]?.startsWith("*/")) {
    const step = Number.parseInt(parts[0]!.slice(2), 10);
    if (Number.isFinite(step) && step > 0) {
      return clamp(step * 60_000 / 2, MIN_GRACE_MS, MAX_GRACE_MS);
    }
  }
  return clamp(60 * 60_000 / 2, MIN_GRACE_MS, MAX_GRACE_MS);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute the next fire time for a schedule given a reference instant.
 * Returns null when the schedule has no future fires (one-shot in the past).
 */
export function computeNextRunAt(s: Schedule, after: Date, seed: string = "squad"): Date | null {
  if (s.kind === "once") {
    const at = new Date(s.at);
    if (at.getTime() <= after.getTime()) return null;
    return at;
  }
  if (s.kind === "interval") {
    const anchor = s.anchor ? new Date(s.anchor).getTime() : after.getTime();
    const diff = after.getTime() - anchor;
    const periods = Math.max(0, Math.ceil((diff + 1) / s.everyMs));
    return new Date(anchor + periods * s.everyMs);
  }
  // cron — search forward minute by minute up to 366 days. Add stagger.
  const stagger = s.staggerMs ?? 0;
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = 60 * 24 * 366;
  for (let i = 0; i < limit; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (matchesCron(s.expr, candidate)) {
      const offset = stagger > 0 ? staggerOffsetMs(seed, "cron-job", stagger) : 0;
      return new Date(candidate.getTime() + offset);
    }
  }
  return null;
}

/**
 * Match a single-minute cron expression ("m h dom mon dow") against a Date.
 * Supports wildcards, numeric values, comma lists, numeric ranges, and
 * step expressions (every-N).
 */
export function matchesCron(expr: string, when: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  return (
    matchField(m!, when.getMinutes(), 0, 59) &&
    matchField(h!, when.getHours(), 0, 23) &&
    matchField(dom!, when.getDate(), 1, 31) &&
    matchField(mon!, when.getMonth() + 1, 1, 12) &&
    matchField(dow!, when.getDay(), 0, 6)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const piece of field.split(",")) {
    if (piece.startsWith("*/")) {
      const step = Number.parseInt(piece.slice(2), 10);
      if (!Number.isFinite(step) || step <= 0) continue;
      if ((value - min) % step === 0) return true;
      continue;
    }
    if (piece.includes("-")) {
      const [loStr, hiStr] = piece.split("-");
      const lo = Number.parseInt(loStr!, 10);
      const hi = Number.parseInt(hiStr!, 10);
      if (Number.isFinite(lo) && Number.isFinite(hi) && value >= lo && value <= hi) return true;
      continue;
    }
    const n = Number.parseInt(piece, 10);
    if (Number.isFinite(n) && n === value) return true;
    void min;
    void max;
  }
  return false;
}
