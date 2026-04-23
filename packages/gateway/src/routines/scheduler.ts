import type { RoutineDescriptor } from "@squad/plugin-sdk";
import type { Logger } from "../logger.js";

/**
 * Tiny cron tick. Runs once per minute, fires any routine whose `cron`
 * expression matches the current minute.
 *
 * Supports a minimal crontab subset: five fields separated by spaces,
 * numeric values, comma lists, and every-N step ranges. Enough for
 * "every morning at 9" without
 * pulling in a cron library.
 */
export interface ScheduleOptions {
  tickMs?: number;
  now?: () => Date;
}

export class RoutineScheduler {
  private readonly routines: RoutineDescriptor[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly lastFired: Map<string, string> = new Map();

  constructor(
    private readonly runRoutine: (r: RoutineDescriptor) => Promise<void>,
    private readonly logger: Logger,
    private readonly opts: ScheduleOptions = {},
  ) {}

  register(routine: RoutineDescriptor): void {
    this.routines.push(routine);
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? 60_000;
    const tick = (): void => {
      const now = (this.opts.now ?? (() => new Date()))();
      const minuteKey = now.toISOString().slice(0, 16);
      for (const r of this.routines) {
        if (this.lastFired.get(r.name) === minuteKey) continue;
        if (!matchesCron(r.cron, now)) continue;
        this.lastFired.set(r.name, minuteKey);
        this.runRoutine(r).catch((err) => {
          this.logger.error({ err, routine: r.name }, "routine threw");
        });
      }
    };
    this.timer = setInterval(tick, tickMs);
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
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
