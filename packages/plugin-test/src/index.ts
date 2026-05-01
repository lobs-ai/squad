import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  parsePluginManifest,
  type PluginManifest,
  type PluginPermission,
} from "@squad/plugin-sdk";

/**
 * Result of validating a plugin's manifest + structure. `errors` is the
 * authoritative pass/fail signal; `warnings` is for things that work today
 * but are likely to break in a future plugin-host release.
 */
export interface ValidationResult {
  ok: boolean;
  manifest?: PluginManifest;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a plugin directory: must contain a `squad.plugin.json` manifest
 * and the `entry` referenced by it must exist on disk.
 */
export function validatePluginDir(dir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);

  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    errors.push(`plugin directory not found: ${abs}`);
    return { ok: false, errors, warnings };
  }

  const manifestPath = join(abs, "squad.plugin.json");
  if (!existsSync(manifestPath)) {
    errors.push(
      `manifest missing: ${manifestPath}. Create one with id, name, version, entry.`,
    );
    return { ok: false, errors, warnings };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    errors.push(`manifest is not valid JSON: ${(err as Error).message}`);
    return { ok: false, errors, warnings };
  }

  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(raw);
  } catch (err) {
    errors.push(`manifest failed schema validation: ${(err as Error).message}`);
    return { ok: false, errors, warnings };
  }

  // Entry exists?
  const entryPath = join(abs, manifest.entry);
  if (!existsSync(entryPath)) {
    errors.push(`entry not found at ${entryPath} (manifest.entry = "${manifest.entry}")`);
  } else {
    const stat = statSync(entryPath);
    if (!stat.isFile()) {
      errors.push(`entry is not a file: ${entryPath}`);
    }
  }

  // SemVer-ish?
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version)) {
    warnings.push(`version "${manifest.version}" does not match semver — recommended.`);
  }

  // Plugins without permissions get unrestricted access today, but the host
  // will eventually require them. Warn loudly so authors migrate.
  if (!manifest.permissions || manifest.permissions.length === 0) {
    warnings.push(
      "manifest.permissions is empty — declare the GatewayAPI namespaces this plugin uses (tools, channels, …). Today this means \"unrestricted\"; future hosts may reject.",
    );
  }

  return {
    ok: errors.length === 0,
    manifest,
    errors,
    warnings,
  };
}

/**
 * The full set of `GatewayAPI` namespaces a plugin can claim. Re-exported here
 * so plugin authors only need a single dependency.
 */
export const ALL_PERMISSIONS: PluginPermission[] = [
  "tools",
  "providers",
  "subagents",
  "routines",
  "skills",
  "approvalPolicies",
  "channels",
  "commands",
  "toolsets",
  "delivery",
  "ui",
];

/**
 * Quick assertion: throws when the plugin dir fails validation. Useful in
 * a plugin's own CI: `assertValidPluginDir(__dirname)`.
 */
export function assertValidPluginDir(dir: string): PluginManifest {
  const result = validatePluginDir(dir);
  if (!result.ok) {
    const lines = [
      `plugin at ${dir} failed validation:`,
      ...result.errors.map((e) => `  - ${e}`),
    ];
    throw new Error(lines.join("\n"));
  }
  return result.manifest!;
}

// Re-resolve directly from a manifest path — used by editor integrations
// that already have the JSON path in hand.
export function validateManifestFile(path: string): ValidationResult {
  return validatePluginDir(dirname(path));
}
