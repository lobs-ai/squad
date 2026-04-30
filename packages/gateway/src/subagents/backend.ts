import type { SubagentBackend } from "@squad/tools";
import type { SubagentPool } from "./pool.js";
import type { SubagentRegistry } from "./registry.js";

export function subagentBackendFor(
  pool: SubagentPool,
  registry: SubagentRegistry,
): SubagentBackend {
  return {
    async spawn(input) {
      const handle = pool.spawn({
        parentSessionId: input.parentSessionId,
        subagent: input.subagent,
        input: input.input,
        ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
        ...(input.toolsets !== undefined ? { toolsets: input.toolsets } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        wait: input.wait,
      });
      if (input.wait) {
        const result = await handle.done;
        return {
          sessionId: handle.sessionId,
          result: result.result,
          succeeded: result.succeeded,
        };
      }
      return { sessionId: handle.sessionId };
    },
    listDefinitions() {
      return registry.list().map((d) => ({ name: d.name, description: d.description }));
    },
  };
}
