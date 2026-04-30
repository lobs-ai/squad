import type { MemoryBackend } from "@squad/tools";
import { DuplicateMemoryError, type MemoryService } from "./service.js";
import { MemoryValidationError } from "./validate.js";

/**
 * Adapt the gateway's MemoryService (MemCore-backed) to the tool-side
 * MemoryBackend interface. Tools never import from the gateway directly —
 * this adapter is the seam.
 */
export function memoryBackendFor(service: MemoryService): MemoryBackend {
  return {
    propose: async (input) => {
      try {
        return await service.propose(input);
      } catch (err) {
        if (err instanceof DuplicateMemoryError) {
          const e = new Error(err.message) as Error & { code?: string; matches?: unknown };
          e.code = "duplicate";
          e.matches = err.matches.map((m) => ({
            id: m.entry.id,
            name: m.entry.name,
            type: m.entry.type,
          }));
          throw e;
        }
        if (err instanceof MemoryValidationError) {
          const e = new Error(err.message) as Error & { code?: string; problems?: unknown };
          e.code = "invalid";
          e.problems = err.problems;
          throw e;
        }
        throw err;
      }
    },
    update: async (input) => service.update(input),
    archive: async (input) =>
      service.archive(input.id, {
        agentId: input.agentId ?? null,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      }),
    search: async (input) => service.search(input),
    list: async (input) => service.list(input),
    get: async (id) => service.get(id),
  };
}
