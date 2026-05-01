/**
 * DoctorBackend — minimal interface the squad_doctor tool talks to.
 *
 * The gateway adapts its in-process Doctor engine to this shape so the tool
 * never imports gateway internals. Tests stub it.
 */

export type DoctorSeverity = "ok" | "info" | "warn" | "error";

export interface DoctorDiagnosis {
  id: string;
  title: string;
  severity: DoctorSeverity;
  message: string;
  detail?: Record<string, unknown>;
  fixable: boolean;
  remediation?: string;
}

export interface DoctorReport {
  generatedAt: string;
  diagnoses: DoctorDiagnosis[];
  summary: { ok: number; info: number; warn: number; error: number };
}

export interface DoctorFixOutcome {
  id: string;
  ok: boolean;
  /** True iff the fix actually mutated state. False on dry-run, no-op, or refusal. */
  applied: boolean;
  message: string;
  changes?: string[];
  warnings?: string[];
  detail?: Record<string, unknown>;
  /** Set when the fix was blocked because a prerequisite check is still erroring. */
  blockedBy?: string[];
}

export interface DoctorListEntry {
  id: string;
  category: string;
  title: string;
  fixable: boolean;
  dependsOn: string[];
}

export interface DoctorFixOptions {
  dryRun?: boolean;
}

export interface DoctorBackend {
  list(): DoctorListEntry[];
  run(ids?: readonly string[]): Promise<DoctorReport>;
  fix(id: string, opts?: DoctorFixOptions): Promise<DoctorFixOutcome>;
}
