/**
 * PluginManagementBackend — the small surface the plugin-management tools
 * need from the host application. The gateway implements this in terms of
 * its `PluginHost` + `ConfigBackend` + dispatcher install path; tests stub it.
 *
 * Tools never import gateway types directly — keeps this package
 * dependency-free and lets unit tests assert against a fake.
 */

export interface PluginCatalogEntrySummary {
  id: string;
  name: string;
  description: string;
  kinds: string[];
  /** True when an entry exists in `config.plugins[]`. */
  installed: boolean;
  /** True when the host has imported and registered the plugin successfully. */
  loaded: boolean;
  /** Populated when a prior load failed — `code` matches PluginLoadError.code. */
  error?: { code: string; message: string; field?: string; envVar?: string; hint?: string };
}

export interface PluginConfigFieldSummary {
  name: string;
  kind: "string" | "number" | "boolean" | "enum" | "array" | "json";
  required: boolean;
  description?: string;
  default?: unknown;
  options?: string[];
  /** Secret fields are auto-generated when blank — don't ask the user. */
  secret?: boolean;
  /** True when the field stores the *name* of an env var to read. */
  envRef?: boolean;
}

export interface PluginDescribeResult {
  id: string;
  name: string;
  description: string;
  fields: PluginConfigFieldSummary[];
  defaultConfig: Record<string, unknown>;
  /** Current saved config (with secrets redacted) when the plugin is installed. */
  currentConfig?: Record<string, unknown>;
  /** True when install will create an `auth.tokens[]` entry. */
  needsAuthToken: boolean;
  /** Author-supplied walkthrough — paraphrase to the user. */
  setupPlaybook?: string;
}

export interface PluginInstallSuccess {
  ok: true;
  /** Loaded plugin's runtime descriptor id. */
  pluginId: string;
  name: string;
  version: string;
  /** Set when the install was a no-op because the plugin was already loaded. */
  alreadyInstalled?: boolean;
}

export interface PluginInstallFailure {
  ok: false;
  /** missing_config | import_failed | register_failed | unknown */
  code: string;
  message: string;
  field?: string;
  envVar?: string;
  hint?: string;
}

export type PluginInstallResult = PluginInstallSuccess | PluginInstallFailure;

export interface PluginUninstallResult {
  ok: boolean;
  message?: string;
}

export interface PluginSetupChatResult {
  /** Newly-created session id the caller should navigate to. */
  sessionId: string;
}

export interface PluginManagementBackend {
  /**
   * Combined catalog + state list. Returns one entry per known catalog
   * plugin including failed installs so the agent can see "this is broken
   * because X" without needing a separate error endpoint.
   */
  list(): Promise<PluginCatalogEntrySummary[]>;
  describe(id: string): Promise<PluginDescribeResult | null>;
  install(
    id: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<PluginInstallResult>;
  uninstall(id: string): Promise<PluginUninstallResult>;
  /**
   * Spin up a new chat session pre-loaded with the plugin's setup playbook
   * + describe output, and return its id. The dashboard / CLI navigates
   * the user to it. Returns `null` when the catalog id is unknown.
   */
  startSetupChat(id: string): Promise<PluginSetupChatResult | null>;
}
