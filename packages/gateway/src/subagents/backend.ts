import type { SubagentBackend } from "@squad/tools";
import type { SubagentDefinition } from "@squad/protocol";
import type { SubagentPool } from "./pool.js";
import type { SubagentRegistry } from "./registry.js";
import type { SubagentDefStore } from "../db/subagent-defs.js";
import { seedCoreFilesAt, subagentCoreDir } from "../agent-prompt.js";

export interface SubagentBackendDeps {
  pool: SubagentPool;
  registry: SubagentRegistry;
  /** Persistence for user-created definitions. */
  defStore?: SubagentDefStore;
  /** Workspace dir used to seed per-name core files on create. */
  workspaceDir: string;
  /** Default model for ad-hoc spawns / created defs without an explicit model. */
  defaultModel: string;
}

export function subagentBackendFor(deps: SubagentBackendDeps): SubagentBackend {
  const { pool, registry, defStore, workspaceDir, defaultModel } = deps;
  return {
    async spawn(input) {
      const handle = pool.spawn({
        parentSessionId: input.parentSessionId,
        ...(input.subagent !== undefined ? { subagent: input.subagent } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
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
      // Async spawn — swallow rejections so they don't surface as
      // UnhandledPromiseRejection. The pool already publishes a
      // `subagents.failed/<id>` event for subscribers; the parent doesn't
      // need a thrown error here since it's intentionally not waiting.
      handle.done.catch(() => {});
      return { sessionId: handle.sessionId };
    },

    listDefinitions() {
      return registry.list().map((d) => ({ name: d.name, description: d.description }));
    },

    async createDefinition(input) {
      const existing = registry.get(input.name);
      if (existing && !input.overwrite) {
        throw new Error(
          `subagent "${input.name}" already exists — pass overwrite: true to replace`,
        );
      }
      const def: SubagentDefinition = {
        name: input.name,
        description: input.description,
        model: input.model ?? defaultModel,
        tools: input.tools ?? [],
        ...(input.toolsets ? { toolsets: input.toolsets } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
        ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
      };
      registry.register(def, "user");
      defStore?.upsert(def);
      const coreDir = subagentCoreDir(workspaceDir, def.name);
      seedCoreFilesAt(
        coreDir,
        def.systemPrompt ? { "SOUL.md": def.systemPrompt } : undefined,
      );
      return { definition: def, coreDir };
    },

    async deleteDefinition(name) {
      const removed = registry.unregister(name);
      defStore?.delete(name);
      return { name, removed };
    },
  };
}
