/**
 * ConfigBackend — minimal interface the config tools talk to.
 *
 * The gateway implements this against config.json with validation through
 * the same zod schema used at boot. Paths are dot-separated, with numeric
 * segments addressing array indices (e.g. `auth.tokens.0.scopes`).
 */

export type ConfigPath = string;

export interface ConfigBackend {
  /** Return the full parsed config object. */
  get(): Promise<Record<string, unknown>>;

  /** Return the value at `path`, or undefined if absent. */
  getValue(path: ConfigPath): Promise<unknown>;

  /**
   * Set the value at `path`. Validates the resulting config, persists to
   * disk, and returns the full new config. Arrays may be set whole or by
   * index; missing intermediate keys are created.
   */
  setValue(path: ConfigPath, value: unknown): Promise<Record<string, unknown>>;

  /**
   * Remove the key/index at `path`. Validates the resulting config and
   * persists. Returns the full new config.
   */
  unsetValue(path: ConfigPath): Promise<Record<string, unknown>>;

  /**
   * Return a flat list of every leaf path currently set in the config,
   * useful for the agent to discover what's configurable.
   */
  listPaths(): Promise<ConfigPath[]>;
}

/** Split a dot path into segments, converting numeric segments to numbers. */
export function splitPath(path: ConfigPath): Array<string | number> {
  if (path === "") return [];
  return path.split(".").map((seg) => {
    if (/^\d+$/.test(seg)) return Number(seg);
    return seg;
  });
}

/** Flatten an object into dot-notation leaf paths. */
export function flattenLeafPaths(obj: unknown, prefix = ""): ConfigPath[] {
  if (obj === null || obj === undefined) return prefix ? [prefix] : [];
  if (typeof obj !== "object") return prefix ? [prefix] : [];
  if (Array.isArray(obj)) {
    if (obj.length === 0) return prefix ? [prefix] : [];
    return obj.flatMap((v, i) =>
      flattenLeafPaths(v, prefix ? `${prefix}.${i}` : String(i)),
    );
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([k, v]) =>
    flattenLeafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}
