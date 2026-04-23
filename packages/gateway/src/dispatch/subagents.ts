import type { Dispatcher } from "./index.js";
import type { SubagentPool } from "../subagents/pool.js";
import type { SubagentRegistry } from "../subagents/registry.js";
import type { SessionStore } from "../db/sessions.js";
import { ProtocolError, ErrorCode, type SubagentDefinition } from "@squad/protocol";

function toWireDef(def: SubagentDefinition): SubagentDefinition {
  return {
    name: def.name,
    description: def.description,
    model: def.model,
    tools: def.tools,
    systemPrompt: def.systemPrompt,
    ...(def.limits !== undefined ? { limits: def.limits } : {}),
    ...(def.inputSchema !== undefined ? { inputSchema: def.inputSchema } : {}),
  };
}

export function registerSubagentMethods(
  dispatcher: Dispatcher,
  pool: SubagentPool,
  registry: SubagentRegistry,
  sessions: SessionStore,
): void {
  dispatcher.register("subagents.list", async () => ({
    definitions: registry.list().map(toWireDef),
  }));

  dispatcher.register("subagents.spawn", async (params) => {
    if (!registry.get(params.subagent)) {
      throw new ProtocolError(
        ErrorCode.not_found,
        `subagent ${params.subagent} is not registered`,
      );
    }
    const handle = pool.spawn({
      parentSessionId: params.parentSessionId,
      subagent: params.subagent,
      input: params.input,
      ...(params.model !== undefined ? { modelOverride: params.model } : {}),
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
