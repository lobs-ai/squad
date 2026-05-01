/**
 * Doctor — engine that runs registered checks and applies their fixes.
 *
 * The engine is intentionally minimal: it holds an ordered list of checks,
 * runs them (in parallel by default), and provides a single seam (`fix`) to
 * apply the auto-repair a check exposes. Failures inside a check or fix are
 * caught here so a bad check can't crash the caller — every problem ends up
 * in the diagnosis it returns.
 */

import type { Logger } from "../logger.js";
import type { Check, Diagnosis, DoctorReport, FixOutcome } from "./types.js";

export interface DoctorOptions {
  logger?: Logger;
}

export class Doctor {
  private readonly checks: Map<string, Check> = new Map();
  private readonly logger: Logger | undefined;
  /** Cache of the last diagnosis per check id — `fix()` reads it to decide
   *  whether to bother. Cleared when the matching check re-runs. */
  private readonly lastDiagnosis: Map<string, Diagnosis> = new Map();

  constructor(opts: DoctorOptions = {}) {
    this.logger = opts.logger;
  }

  register(check: Check): void {
    if (this.checks.has(check.id)) {
      throw new Error(`doctor: duplicate check id "${check.id}"`);
    }
    this.checks.set(check.id, check);
  }

  registerAll(checks: readonly Check[]): void {
    for (const c of checks) this.register(c);
  }

  /** Listing for the `list` action — id, category, title, fixable hint. */
  list(): Array<{ id: string; category: string; title: string; fixable: boolean }> {
    return Array.from(this.checks.values()).map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      fixable: typeof c.fix === "function",
    }));
  }

  /**
   * Run a subset (or all, when `ids` is omitted) and return a report. Checks
   * run in parallel; the result preserves registration order.
   */
  async run(ids?: readonly string[]): Promise<DoctorReport> {
    const targets = this.resolveTargets(ids);
    const ordered = Array.from(this.checks.values()).filter((c) => targets.has(c.id));
    const settled = await Promise.all(ordered.map((c) => this.runOne(c)));
    const summary = { ok: 0, info: 0, warn: 0, error: 0 };
    for (const d of settled) summary[d.severity]++;
    return {
      generatedAt: new Date().toISOString(),
      diagnoses: settled,
      summary,
    };
  }

  /**
   * Apply a check's fix. Re-runs the check first so we don't fix a stale
   * diagnosis; bails when the check is healthy or unfixable.
   */
  async fix(id: string): Promise<FixOutcome> {
    const check = this.checks.get(id);
    if (!check) {
      return { id, ok: false, message: `unknown check "${id}"` };
    }
    if (!check.fix) {
      return { id, ok: false, message: `check "${id}" has no fix` };
    }
    const fresh = await this.runOne(check);
    if (fresh.severity === "ok") {
      return { id, ok: true, message: "already healthy — nothing to fix" };
    }
    if (!fresh.fixable) {
      return { id, ok: false, message: fresh.message };
    }
    try {
      const outcome = await check.fix(fresh);
      // Re-run to refresh the cache so a follow-up `list` reflects the fix.
      await this.runOne(check);
      return outcome;
    } catch (err) {
      this.logger?.error({ err, id }, "doctor fix threw");
      return {
        id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Look up the most recent diagnosis for an id without re-running. */
  peek(id: string): Diagnosis | undefined {
    return this.lastDiagnosis.get(id);
  }

  private resolveTargets(ids?: readonly string[]): Set<string> {
    if (!ids || ids.length === 0) return new Set(this.checks.keys());
    const known = new Set(this.checks.keys());
    const targets = new Set<string>();
    for (const id of ids) {
      if (known.has(id)) targets.add(id);
    }
    return targets;
  }

  private async runOne(check: Check): Promise<Diagnosis> {
    try {
      const d = await check.run();
      this.lastDiagnosis.set(check.id, d);
      return d;
    } catch (err) {
      this.logger?.error({ err, id: check.id }, "doctor check threw");
      const fallback: Diagnosis = {
        id: check.id,
        title: check.title,
        severity: "error",
        message:
          err instanceof Error ? `check threw: ${err.message}` : "check threw a non-Error value",
        fixable: false,
      };
      this.lastDiagnosis.set(check.id, fallback);
      return fallback;
    }
  }
}
