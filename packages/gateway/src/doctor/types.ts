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
  detail?: Record<string, unknown>;
}

export interface Check {
  /** Stable identifier — referenced by the squad_doctor tool. */
  id: string;
  /** Logical area the check covers (memory, llm, db, …). */
  category: string;
  /** Short human-readable label. */
  title: string;
  /**
   * Inspect the system. Must never throw — return an `error` severity
   * diagnosis instead. Implementations should be cheap and not have
   * cross-check side effects.
   */
  run(): Promise<Diagnosis>;
  /**
   * Optional repair. Only called when the latest diagnosis was `fixable`.
   * Returns whatever the operation produced; the engine wraps failures.
   */
  fix?(diagnosis: Diagnosis): Promise<FixOutcome>;
}

export interface DoctorReport {
  generatedAt: string;
  diagnoses: Diagnosis[];
  /** Counts by severity, for quick at-a-glance triage. */
  summary: { ok: number; info: number; warn: number; error: number };
}
