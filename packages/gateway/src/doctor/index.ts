export { Doctor } from "./engine.js";
export type {
  Check,
  Diagnosis,
  DoctorReport,
  FixOutcome,
  Severity,
} from "./types.js";
export { createBuiltinChecks } from "./checks.js";
export type { BuiltinDeps, LlmResolutionSnapshot } from "./checks.js";
export { doctorBackendFor } from "./backend.js";
