import type { DoctorBackend } from "@squad/tools";
import type { Doctor } from "./engine.js";

/**
 * Adapt the gateway's Doctor engine to the tool-side DoctorBackend interface.
 * Tools never import from `@squad/gateway` directly — this adapter is the
 * seam, mirroring memoryBackendFor / cronBackendFor.
 */
export function doctorBackendFor(doctor: Doctor): DoctorBackend {
  return {
    list: () => doctor.list(),
    run: async (ids) => doctor.run(ids),
    fix: async (id) => doctor.fix(id),
  };
}
