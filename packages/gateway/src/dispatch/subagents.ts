import type { Dispatcher } from "./index.js";
import type { SubagentPool } from "../subagents/pool.js";
import type { SubagentRegistry } from "../subagents/registry.js";
import type { SubagentDefStore } from "../db/subagent-defs.js";
import type { SessionStore } from "../db/sessions.js";
import { ProtocolError, ErrorCode, type SubagentDefinition } from "@squad/protocol";
import { seedCoreFilesAt, subagentCoreDir } from "../agent-prompt.js";

function toWireDef(def: SubagentDefinition): SubagentDefinition {
  return {
    name: def.name,
    description: def.description,
    model: def.model,
    tools: def.tools,
    ...(def.toolsets !== undefined ? { toolsets: def.toolsets } : {}),
    ...(def.systemPrompt !== undefined ? { systemPrompt: def.systemPrompt } : {}),
    ...(def.limits !== undefined ? { limits: def.limits } : {}),
    ...(def.inputSchema !== undefined ? { inputSchema: def.inputSchema } : {}),
  };
}

export interface SubagentDispatchDeps {
  pool: SubagentPool;
  registry: SubagentRegistry;
  sessions: SessionStore;
  defStore?: SubagentDefStore;
  workspaceDir: string;
  defaultModel: string;
}

export function registerSubagentMethods(
  dispatcher: Dispatcher,
  deps: SubagentDispatchDeps,
): void {
  const { pool, registry, sessions, defStore, workspaceDir, defaultModel } = deps;

  dispatcher.register("subagents.list", async () => ({
    definitions: registry.list().map(toWireDef),
  }));

  dispatcher.register("subagents.spawn", async (params) => {
    if (params.subagent && !registry.get(params.subagent)) {
      throw new ProtocolError(
        ErrorCode.not_found,
        `subagent ${params.subagent} is not registered`,
      );
    }
    if (!params.subagent && !params.prompt) {
      throw new ProtocolError(
        ErrorCode.invalid_params,
        "subagents.spawn: provide either `subagent` (named) or `prompt` (ad-hoc)",
      );
    }
    const handle = pool.spawn({
      parentSessionId: params.parentSessionId,
      ...(params.subagent !== undefined ? { subagent: params.subagent } : {}),
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.model !== undefined ? { modelOverride: params.model } : {}),
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
      ...(params.toolsets !== undefined ? { toolsets: params.toolsets } : {}),
      wait: params.wait,
    });
    if (params.wait) {
      const outcome = await handle.done;
      return {
        sessionId: handle.sessionId,
        status: outcome.succeeded ? "completed" : "failed",
        result: outcome.result,
      };
    }
    return { sessionId: handle.sessionId, status: "running" };
  });

  dispatcher.register("subagents.cancel", async (params) => {
    pool.cancelTree(params.sessionId);
    return { sessionId: params.sessionId, cancelled: true };
  });

  dispatcher.register("subagents.create", async (params) => {
    const existing = registry.get(params.name);
    if (existing && !params.overwrite) {
      throw new ProtocolError(
        ErrorCode.conflict,
        `subagent "${params.name}" already exists — pass overwrite: true to replace`,
      );
    }
    const def: SubagentDefinition = {
      name: params.name,
      description: params.description,
      model: params.model ?? defaultModel,
      tools: params.tools ?? [],
      ...(params.toolsets ? { toolsets: params.toolsets } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.limits ? { limits: params.limits } : {}),
      ...(params.inputSchema ? { inputSchema: params.inputSchema } : {}),
    };
    registry.register(def, "user");
    defStore?.upsert(def);
    const coreDir = subagentCoreDir(workspaceDir, def.name);
    seedCoreFilesAt(
      coreDir,
      def.systemPrompt ? { "SOUL.md": def.systemPrompt } : undefined,
    );
    return { definition: toWireDef(def), coreDir };
  });

  dispatcher.register("subagents.delete", async (params) => {
    const removed = registry.unregister(params.name);
    defStore?.delete(params.name);
    return { name: params.name, removed };
  });

  dispatcher.register("subagents.tree", async (params) => {
    const root = sessions.tryGet(params.rootSessionId);
    if (!root) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.rootSessionId} not found`);
    }
    type Node = {
      sessionId: string;
      subagent: string | null;
      status: "queued" | "running" | "completed" | "failed" | "cancelled";
      children: Node[];
    };
    const nodeFor = (sessionId: string): Node => {
      const s = sessions.get(sessionId);
      const children = sessions
        .list({ parentSessionId: sessionId, limit: 50 })
        .map((c) => nodeFor(c.id));
      return {
        sessionId: s.id,
        subagent: s.subagentDefId,
        status:
          s.status === "running" ? "running" : s.status === "ended" ? "completed" : "queued",
        children,
      };
    };
    return { root: nodeFor(root.id) };
  });

  dispatcher.register("subagents.history", async (params) => {
    const s = sessions.tryGet(params.sessionId);
    if (!s) {
      throw new ProtocolError(ErrorCode.not_found, `session ${params.sessionId} not found`);
    }
    return {
      sessionId: s.id,
      subagent: s.subagentDefId,
      status: (s.status === "running"
        ? "running"
        : s.status === "ended"
          ? "completed"
          : "queued") as "queued" | "running" | "completed",
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
    };
  });
}
