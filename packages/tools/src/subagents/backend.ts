/**
 * SubagentBackend — the minimum interface the spawn_subagent tool needs
 * from the gateway. Keeps @squad/tools ignorant of the pool's internals.
 */
export interface SubagentBackend {
  /**
   * Spawn a subagent by registered name. Returns immediately with a session
   * id; if `wait` is true, also resolves the `done` promise to the final
   * result. If `wait` is false the caller polls or subscribes via the
   * protocol.
   */
  spawn(input: {
    parentSessionId: string;
    subagent: string;
    input: unknown;
    modelOverride?: string;
    wait: boolean;
  }): Promise<{ sessionId: string; result?: unknown; succeeded?: boolean }>;

  listDefinitions(): Array<{ name: string; description: string }>;
}
