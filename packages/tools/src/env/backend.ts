/**
 * EnvBackend — minimal interface the env-management tools talk to. The
 * gateway implements this against its SecretStore (file-backed, mode 0600,
 * merged into `process.env` at boot and on every write). Tools never
 * import the gateway directly.
 *
 * "Env" here is the agent-visible vocabulary — anything the user might
 * call an environment variable. The implementation under the hood writes
 * to the same secret store plugins.install uses, so values set via
 * `set_env` are immediately visible via `process.env[name]` and survive
 * across restarts without a restart-the-container dance.
 */
export interface EnvBackend {
  /**
   * Set (or replace) an env value. Persists to disk and updates
   * `process.env[name]` in the running gateway, so tools/plugins/agents
   * pick it up on the next read without a restart.
   */
  set(name: string, value: string): Promise<void>;
  /** Remove an env entry. Idempotent — silent when the entry doesn't exist. */
  unset(name: string): Promise<void>;
  /**
   * List the names currently stored. Values are NOT returned — these are
   * potential secrets and we don't want them surfaced through the LLM.
   */
  listNames(): Promise<string[]>;
  /**
   * True when an entry with this name is stored. Useful for the agent to
   * check before re-asking the user for a value they already provided.
   */
  has(name: string): Promise<boolean>;
}
