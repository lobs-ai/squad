import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-run agent context. Threaded through AsyncLocalStorage so callbacks
 * captured at gateway boot (e.g. the claude-cli MCP bridge executor) can
 * read the live `sessionId` / `taskId` of the run that's currently calling
 * them without us having to plumb the values through every layer of the
 * LLM client interface.
 */
export interface AgentContext {
  sessionId: string;
  taskId?: string;
}

const storage = new AsyncLocalStorage<AgentContext>();

/** Run `fn` with `ctx` set as the current agent context. */
export function runWithAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Read the current agent context, or `undefined` outside a run. */
export function currentAgentContext(): AgentContext | undefined {
  return storage.getStore();
}
