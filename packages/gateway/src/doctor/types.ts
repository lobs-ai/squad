/**
 * Squad Doctor — typed contract for diagnostic checks.
 *
 * A `Check` knows how to inspect one slice of the system (memory, db, llm,
 * channels, …) and report a `Diagnosis`. When a problem is auto-fixable, the
 * check supplies a `fix` function. The engine ties checks together so the
 * agent (via the `squad_doctor` tool) and humans can list, run, and fix
 * issues without each call site re-implementing the wiring.
 */

export type Severity = "ok" | "info" | "warn" | "error";

export interface Diagnosis {
  /** Stable check id (kebab-case, e.g. `memory.embedder`). */
  id: string;
  /** One-line human summary of what the check looked at. */
  title: string;
  severity: Severity;
  /** Human-readable explanation of what was found. */
  message: string;
  /** Free-form structured data — counts, paths, ids — useful for agents. */
  detail?: Record<string, unknown>;
  /** True iff `Check.fix` exists AND this diagnosis is fixable. */
  fixable: boolean;
  /** Short hint about *what* a fix would do, if applicable. */
  remediation?: string;
}

export interface FixOutcome {
  id: string;
  ok: boolean;
  message: string;
  /**
   * False when `dryRun` was set — the check ran its preview path and the
   * system was not modified. True for a normal fix or when there was nothing
   * to do.
   */
  applied: boolean;
  /** Granular per-step changes the fix applied (or would apply, in dryRun). */
  changes?: string[];
  /** Side notes the fix raised — caveats, follow-ups, partial failures. */
  warnings?: string[];
  detail?: Record<string, unknown>;
  /**
   * Set when the engine refused to call the fix because a `dependsOn` check
   * is still in `error`. The check that blocked is in `blockedBy`.
   */
  blockedBy?: string[];
}

export interface FixContext {
  /** Preview-only run — perform no mutations, just report what would change. */
  dryRun: boolean;
}

export interface Check {
  /** Stable identifier — referenced by the squad_doctor tool. */
  id: string;
  /** Logical area the check covers (memory, llm, db, …). */
  category: string;
  /** Short human-readable label. */
  title: string;
  /**
   * Other check ids whose `error` severity should block this check's `fix`.
   * The engine never auto-applies a fix while a prerequisite is broken —
   * acting on a stale view is how doctors do harm. Diagnoses still run.
   */
  dependsOn?: readonly string[];
  /**
   * Inspect the system. Must never throw — return an `error` severity
   * diagnosis instead. Implementations should be cheap and not have
   * cross-check side effects.
   */
  run(): Promise<Diagnosis>;
  /**
   * Optional repair. Only called when the latest diagnosis was `fixable`.
   * Implementations must honor `ctx.dryRun`: when true, return what *would*
   * change in `changes`/`detail` without mutating any state.
   */
  fix?(diagnosis: Diagnosis, ctx: FixContext): Promise<FixOutcome>;
}

export interface DoctorReport {
  generatedAt: string;
  diagnoses: Diagnosis[];
  /** Counts by severity, for quick at-a-glance triage. */
  summary: { ok: number; info: number; warn: number; error: number };
}
