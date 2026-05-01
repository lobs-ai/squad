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
  message: string;
  detail?: Record<string, unknown>;
}

export interface DoctorListEntry {
  id: string;
  category: string;
  title: string;
  fixable: boolean;
}

export interface DoctorBackend {
  list(): DoctorListEntry[];
  run(ids?: readonly string[]): Promise<DoctorReport>;
  fix(id: string): Promise<DoctorFixOutcome>;
}
