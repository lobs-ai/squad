import type { MemoryBackend } from "@squad/tools";
import type { MemoryStore } from "./store.js";
import { DuplicateMemoryError } from "./store.js";
import { MemoryValidationError } from "./validate.js";

/**
 * Adapt the gateway's MemoryStore to the tool-side MemoryBackend interface.
 * Tools never import from the gateway directly — this adapter is the seam.
 */
export function memoryBackendFor(store: MemoryStore): MemoryBackend {
  return {
    propose: async (input) => {
      try {
        return store.propose(input);
      } catch (err) {
        if (err instanceof DuplicateMemoryError) {
          const e = new Error(err.message) as Error & { code?: string; matches?: unknown };
          e.code = "duplicate";
          e.matches = err.matches.map((m) => ({ id: m.entry.id, name: m.entry.name, type: m.entry.type }));
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
    update: async (input) => store.update(input),
    archive: async (input) => store.archive(input.id, { agentId: input.agentId ?? null, ...(input.reason !== undefined ? { reason: input.reason } : {}) }),
    search: async (input) => store.search(input),
    list: async (input) => store.list(input),
    get: async (id) => store.get(id),
  };
}
