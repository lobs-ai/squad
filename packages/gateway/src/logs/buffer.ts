import type { Broadcast } from "../broadcast.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * One captured log entry. Mirrors the on-the-wire shape exposed by the
 * `logs.tail` method and the `logs.entry` event so the dashboard/CLI can
 * render without translation.
 */
export interface LogEntry {
  /** Monotonically increasing id assigned at capture time. */
  id: number;
  /** ISO timestamp from pino. */
  time: string;
  /** Pino level name (trace|debug|info|warn|error|fatal). */
  level: LogLevel;
  /** Best-effort source label — `bindings.component` || `bindings.service`. */
  source: string | null;
  /** The pino msg field. */
  msg: string;
  /** Every other field on the pino record (component, requestId, err, etc). */
  bindings: Record<string, unknown>;
}

const PINO_LEVELS: Array<[number, LogLevel]> = [
  [60, "fatal"],
  [50, "error"],
  [40, "warn"],
  [30, "info"],
  [20, "debug"],
  [10, "trace"],
];

const LEVEL_SET = new Set<LogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);

function levelName(level: number | string | undefined): LogLevel {
  if (typeof level === "string") {
    return LEVEL_SET.has(level as LogLevel) ? (level as LogLevel) : "info";
  }
  if (typeof level !== "number") return "info";
  for (const [n, name] of PINO_LEVELS) if (level >= n) return name;
  return "trace";
}

/**
 * Bounded ring buffer of captured log entries plus a pino-compatible
 * writable that parses each line and pushes it. Pair with `pino.multistream`
 * so stdout still gets the raw output.
 *
 * The buffer doubles as the broadcast source for `logs.entry` — once the
 * gateway has constructed its `Broadcast`, call `attachBroadcast` and live
 * tailers receive every subsequent entry.
 */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private nextId = 1;
  private broadcast: Broadcast | null = null;

  constructor(private readonly capacity: number = 2000) {}

  attachBroadcast(b: Broadcast): void {
    this.broadcast = b;
  }

  /** Pino-multistream-compatible target. */
  stream(): { write: (chunk: string) => void } {
    return {
      write: (chunk: string) => this.ingest(chunk),
    };
  }

  ingest(chunk: string): void {
    // pino emits one JSON object per line. Multiple lines may be flushed in
    // a single write; split defensively.
    const lines = chunk.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const entry = this.toEntry(parsed);
      this.push(entry);
    }
  }

  private toEntry(obj: Record<string, unknown>): LogEntry {
    const reserved = new Set(["level", "time", "msg", "pid", "hostname"]);
    const bindings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (reserved.has(k)) continue;
      bindings[k] = v;
    }
    const source =
      (typeof bindings.component === "string" && bindings.component) ||
      (typeof bindings.source === "string" && bindings.source) ||
      (typeof bindings.service === "string" && bindings.service) ||
      null;
    return {
      id: this.nextId++,
      time: typeof obj.time === "string" ? obj.time : new Date().toISOString(),
      level: levelName(obj.level as number | string | undefined),
      source,
      msg: typeof obj.msg === "string" ? obj.msg : "",
      bindings,
    };
  }

  private push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.broadcast?.publish("logs.entry", { entry });
  }

  /**
   * Newest-first slice with optional level/source/sinceId/q filters and a
   * cap. Reads from a copy so the caller can iterate safely.
   */
  tail(opts: {
    limit?: number;
    level?: LogLevel;
    source?: string;
    sinceId?: number;
    q?: string;
  } = {}): LogEntry[] {
    const minRank = opts.level ? rankOf(opts.level) : 0;
    const q = opts.q?.toLowerCase();
    const out: LogEntry[] = [];
    // Walk newest → oldest so we can short-circuit when we hit `limit`.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (opts.sinceId !== undefined && e.id <= opts.sinceId) break;
      if (minRank && rankOf(e.level) < minRank) continue;
      if (opts.source && e.source !== opts.source) continue;
      if (q && !matchesQuery(e, q)) continue;
      out.push(e);
      if (opts.limit && out.length >= opts.limit) break;
    }
    out.reverse();
    return out;
  }

  /** Distinct source labels currently in the buffer, sorted. */
  sources(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) if (e.source) set.add(e.source);
    return [...set].sort();
  }
}

function rankOf(level: LogLevel): number {
  for (const [n, name] of PINO_LEVELS) if (name === level) return n;
  return 0;
}

function matchesQuery(e: LogEntry, q: string): boolean {
  if (e.msg.toLowerCase().includes(q)) return true;
  if (e.source && e.source.toLowerCase().includes(q)) return true;
  // Cheap depth-1 scan over bindings; deep search isn't worth the cost here.
  for (const v of Object.values(e.bindings)) {
    if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
  }
  return false;
}
