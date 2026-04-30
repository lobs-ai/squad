/**
 * SubagentBackend — the minimum interface the subagent tools need from the
 * gateway. Keeps @squad/tools ignorant of the pool's internals.
 */
export interface SubagentBackend {
  /**
   * Spawn a subagent. Two modes:
   *
   *   - **Named**: pass `subagent` to use a registered definition. The
   *     definition supplies model + tool list + per-name core files.
   *   - **Ad-hoc**: omit `subagent`. The caller supplies `prompt` (and
   *     optionally `tools`/`toolsets`/`model`/`name`). No core files are
   *     loaded — it's a one-shot worker.
   *
   * `prompt` is delivered as the first user message in either mode. The
   * system prompt is always the Squad system prompt.
   *
   * Returns immediately with a session id; if `wait` is true, also resolves
   * the `done` promise to the final result.
   */
  spawn(input: {
    parentSessionId: string;
    /** Registered subagent name. Omit for ad-hoc spawns. */
    subagent?: string;
    /** First user message. Required when `subagent` is omitted. */
    prompt?: string;
    /** Optional structured payload — stringified into the first user message. */
    input?: unknown;
    /** Telemetry label for ad-hoc spawns. */
    name?: string;
    modelOverride?: string;
    /** Optional toolset bundles unioned with the definition's tools. */
    toolsets?: string[];
    /** Optional ad-hoc tool ids unioned with the definition's tools. */
    tools?: string[];
    wait: boolean;
  }): Promise<{ sessionId: string; result?: unknown; succeeded?: boolean }>;

  listDefinitions(): Array<{ name: string; description: string }>;

  /** Register or replace a subagent definition at runtime. */
  createDefinition(input: {
    name: string;
    description: string;
    model?: string;
    tools?: string[];
    toolsets?: string[];
    systemPrompt?: string;
    limits?: { maxTokens?: number; maxToolCalls?: number; timeoutMs?: number };
    inputSchema?: Record<string, unknown>;
    overwrite?: boolean;
  }): Promise<{
    definition: {
      name: string;
      description: string;
      model: string;
      tools: string[];
      toolsets?: string[];
      systemPrompt?: string;
      limits?: { maxTokens?: number; maxToolCalls?: number; timeoutMs?: number };
      inputSchema?: Record<string, unknown>;
    };
    coreDir: string;
  }>;

  /** Remove a registered subagent. */
  deleteDefinition(name: string): Promise<{ name: string; removed: boolean }>;
}
