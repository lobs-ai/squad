// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/hooks.ts
// Last synced: 2026-04-23

/**
 * Hook registry — lifecycle hooks for the agent execution loop.
 *
 * Hooks let consumers observe and intercept agent execution at key points:
 * - before/after LLM calls
 * - before/after tool calls (can deny or modify tool calls)
 * - agent start/end
 * - context compaction
 * - errors
 *
 * Usage:
 * ```ts
 * const registry = getHookRegistry();
 * registry.register("before_tool_call", async (event) => {
 *   if (event.data.toolName === "exec") {
 *     // Inspect or modify the tool call
 *   }
 *   return event; // return null to deny execution
 * });
 * ```
 */

// ── Event Types ───────────────────────────────────────────────────────────────

export type HookEventType =
  | "before_agent_start"
  | "after_agent_end"
  | "before_llm_call"
  | "after_llm_call"
  | "before_tool_call"
  | "after_tool_call"
  | "on_error"
  | "session_compacted";

export interface HookEvent {
  agentType: string;
  taskId: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export type HookHandler = (
  event: HookEvent,
) => Promise<HookEvent | null> | HookEvent | null;

// ── Registry ──────────────────────────────────────────────────────────────────

export class HookRegistry {
  private handlers = new Map<HookEventType, HookHandler[]>();

  /** Register a handler for a hook event type. */
  register(type: HookEventType, handler: HookHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Unregister all handlers for a hook event type. */
  unregister(type: HookEventType): void {
    this.handlers.delete(type);
  }

  /**
   * Emit a hook event.
   *
   * Handlers are called in registration order. If any handler returns `null`,
   * the chain is broken and `null` is returned (used to deny tool execution).
   *
   * @returns The (possibly modified) event, or null if denied.
   */
  async emit(
    type: HookEventType,
    event: HookEvent,
  ): Promise<HookEvent | null> {
    const handlers = this.handlers.get(type) ?? [];
    let current: HookEvent | null = event;

    for (const handler of handlers) {
      if (current === null) break;
      try {
        current = await handler(current);
      } catch {
        // Hook errors must not crash the agent loop
        current = event;
      }
    }

    return current;
  }

  /** Clear all registered handlers. */
  clear(): void {
    this.handlers.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _registry: HookRegistry | null = null;

/**
 * Get the global hook registry.
 * Creates the registry on first call.
 */
export function getHookRegistry(): HookRegistry {
  if (!_registry) {
    _registry = new HookRegistry();
  }
  return _registry;
}

/**
 * Reset the global hook registry (useful in tests).
 */
export function resetHookRegistry(): void {
  _registry = null;
}
