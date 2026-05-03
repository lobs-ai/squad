import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { RoutineRunLog } from "@squad/protocol";
import { logger as rootLogger } from "../logger.js";

const log = rootLogger.child({ component: "routines.persistence" });

/**
 * File layout under <data_dir>/cron/:
 *
 *   jobs.json              persistent job config
 *   state.json             runtime state (lastRunAt, nextRunAt, errors)
 *   runs/<jobId>.jsonl     append-only run telemetry, tail-pruned
 *   .tick.lock             advisory single-tick lock
 */
export interface CronPaths {
  root: string;
  jobs: string;
  state: string;
  runs: string;
  tickLock: string;
}

export function ensureCronPaths(dataDir: string): CronPaths {
  const root = join(dataDir, "cron");
  mkdirSync(root, { recursive: true });
  const runs = join(root, "runs");
  mkdirSync(runs, { recursive: true });
  return {
    root,
    jobs: join(root, "jobs.json"),
    state: join(root, "state.json"),
    runs,
    tickLock: join(root, ".tick.lock"),
  };
}

/** Atomic write: write tmp + rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readJsonOrEmpty<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    log.error({ err, path }, "routines: failed to read/parse JSON — using fallback");
    return fallback;
  }
}

/**
 * Best-effort exclusive open of `path` to mark a tick in progress. Returns
 * a release fn that closes + unlinks the lock. If the lock already exists,
 * returns null and the caller should skip its tick.
 */
export function tryAcquireTickLock(path: string): null | (() => void) {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      closeSync(fd);
    } catch (err) {
      log.debug({ err, path }, "routines: tick lock close failed");
    }
    try {
      unlinkSync(path);
    } catch (err) {
      log.debug({ err, path }, "routines: tick lock unlink failed (already cleaned up?)");
    }
  };
}

/**
 * Append a run log entry to <runs>/<jobId>.jsonl, then prune the file to
 * `keep` lines if it has grown past `keep + slack`. Pruning is "rewrite the
 * tail" — fine for the small (<1MB typical) per-job files we expect.
 */
export function appendRunLog(
  runsDir: string,
  jobId: string,
  entry: RoutineRunLog,
  keep = 200,
): void {
  if (!isSafeJobId(jobId)) throw new Error(`unsafe jobId: ${jobId}`);
  const path = join(runsDir, `${jobId}.jsonl`);
  appendFileSync(path, JSON.stringify(entry) + "\n");
  // Cheap line count: stat-based heuristic. Only re-read when the file
  // looks like it crossed the threshold.
  try {
    const size = statSync(path).size;
    if (size < keep * 256) return; // very rough — skip prune
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length <= keep) return;
    const tail = lines.slice(-keep).join("\n") + "\n";
    writeJsonAtomicRaw(path, tail);
  } catch (err) {
    log.warn({ err, jobId, path }, "routines: run log prune failed");
  }
}

export function readRunLog(
  runsDir: string,
  jobId: string,
  opts: { limit: number; status?: "ok" | "error" | "skipped" },
): RoutineRunLog[] {
  if (!isSafeJobId(jobId)) return [];
  const path = join(runsDir, `${jobId}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: RoutineRunLog[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as RoutineRunLog;
      if (opts.status && obj.status !== opts.status) continue;
      out.push(obj);
    } catch (err) {
      log.warn({ err, jobId, lineSample: line.slice(0, 120) }, "routines: skipping malformed run log line");
    }
  }
  return out.slice(-opts.limit).reverse();
}

export function pruneOrphanedRunLogs(runsDir: string, knownJobIds: Set<string>): void {
  if (!existsSync(runsDir)) return;
  for (const f of readdirSync(runsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.slice(0, -".jsonl".length);
    if (!knownJobIds.has(id)) {
      try {
        unlinkSync(join(runsDir, f));
        log.info({ jobId: id, file: f }, "routines: pruned orphaned run log");
      } catch (err) {
        log.warn({ err, jobId: id, file: f }, "routines: orphaned run log unlink failed");
      }
    }
  }
}

/**
 * Deterministic stagger offset in milliseconds for `[0, windowMs)`. Same
 * jobId always produces the same offset given the same seed — used to
 * spread fires within the matched cron minute.
 */
export function staggerOffsetMs(seed: string, jobId: string, windowMs: number): number {
  if (windowMs <= 0) return 0;
  const h = createHash("sha256").update(seed).update("/").update(jobId).digest();
  // Use first 6 bytes — enough range, fits in JS number safely.
  const n =
    h[0]! * 2 ** 40 +
    h[1]! * 2 ** 32 +
    h[2]! * 2 ** 24 +
    h[3]! * 2 ** 16 +
    h[4]! * 2 ** 8 +
    h[5]!;
  return n % windowMs;
}

// Internal — like writeJsonAtomic but for raw strings.
function writeJsonAtomicRaw(path: string, contents: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function isSafeJobId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
