/**
 * Structured error a plugin throws from `register(api)` when required
 * configuration is missing. The host catches this, attaches the plugin id,
 * and re-throws as a {@link PluginLoadError} with a `code: "missing_config"`
 * marker. The dispatcher surfaces it to clients as a typed install error
 * the dashboard renders as a "needs setup" prompt instead of a generic toast.
 */
export class MissingConfigError extends Error {
  readonly code = "missing_config" as const;
  /** Field name in the plugin's configSchema that's blank. */
  readonly field: string;
  /** Env var the plugin reads when the field is `*_env`. */
  readonly envVar?: string;
  /** One-line human guidance — shown verbatim under the field in the UI. */
  readonly hint?: string;

  constructor(args: { field: string; envVar?: string; hint?: string; message?: string }) {
    super(
      args.message ??
        `Plugin configuration field "${args.field}" is required` +
          (args.envVar ? ` (env var: ${args.envVar})` : ""),
    );
    this.name = "MissingConfigError";
    this.field = args.field;
    if (args.envVar !== undefined) this.envVar = args.envVar;
    if (args.hint !== undefined) this.hint = args.hint;
  }
}

/**
 * Wrapper the plugin host raises when `descriptor.register(api)` (or the
 * dynamic import itself) throws. Carries the plugin id and the original
 * error so callers can render a row-scoped error without hand-parsing
 * stack traces.
 *
 * `code` is one of:
 *  - `missing_config` → unwrap `details.field` / `details.envVar` to drive
 *    a configure-form prompt.
 *  - `import_failed`  → the dynamic `import()` threw (bad path, syntax err,
 *    transient module resolution).
 *  - `register_failed` → the plugin's `register()` threw for any other reason.
 */
export class PluginLoadError extends Error {
  readonly code: "missing_config" | "import_failed" | "register_failed";
  readonly pluginSource: string;
  readonly pluginId?: string;
  readonly cause?: unknown;
  /** Field-shaped details for `missing_config`; free-form for the others. */
  readonly details: Record<string, unknown>;

  constructor(args: {
    code: "missing_config" | "import_failed" | "register_failed";
    pluginSource: string;
    pluginId?: string;
    message: string;
    cause?: unknown;
    details?: Record<string, unknown>;
  }) {
    super(args.message);
    this.name = "PluginLoadError";
    this.code = args.code;
    this.pluginSource = args.pluginSource;
    if (args.pluginId !== undefined) this.pluginId = args.pluginId;
    if (args.cause !== undefined) this.cause = args.cause;
    this.details = args.details ?? {};
  }
}
