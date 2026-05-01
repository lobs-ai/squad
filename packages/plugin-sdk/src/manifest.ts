import { z } from "zod";

/**
 * `squad.plugin.json` — declarative manifest co-located with a plugin's
 * entry file. The plugin host loads it before importing the entry, then
 * enforces declared permissions when the plugin calls `GatewayAPI.*`.
 *
 * Manifests are optional for now — plugins without one keep working with
 * unrestricted access (back-compat). Plugin authors who ship a manifest
 * get permission enforcement, dependency declarations, and a stable
 * surface for the plugin marketplace later.
 */

export const pluginPermissionSchema = z.enum([
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
]);
export type PluginPermission = z.infer<typeof pluginPermissionSchema>;

export const pluginManifestSchema = z.object({
  /** Unique id, dotted/dashed convention (e.g. "@squad/channel-discord"). */
  id: z.string().min(1),
  /** Human-friendly name. */
  name: z.string().min(1),
  /** SemVer string. */
  version: z.string().min(1),
  /**
   * Path (relative to manifest dir) to the entry module. The host appends
   * "?t=<timestamp>" on hot-reload to defeat module cache.
   */
  entry: z.string().min(1),
  /**
   * Plugin kinds this manifest claims to expose. Mirrors the
   * `PluginDescriptor.kinds` field; included here so the host can pre-flight
   * a manifest before importing.
   */
  exposes: z.array(z.enum([
    "tool",
    "provider",
    "channel",
    "skill",
    "routine",
    "subagent",
  ])).default([]),
  /**
   * GatewayAPI namespaces this plugin is allowed to register into. Calls
   * to other namespaces throw at runtime. Unset = unrestricted (back-compat).
   */
  permissions: z.array(pluginPermissionSchema).optional(),
  /**
   * Other plugin ids this one needs loaded first. Each entry can be a bare
   * id or `id@semver-range`. The host fails plugin load when a `requires`
   * entry is missing or version-incompatible.
   */
  requires: z.array(z.string()).default([]),
  /** Optional homepage / docs URL. Surfaced by the dashboard's plugin list. */
  homepage: z.string().optional(),
  description: z.string().optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export interface PluginManifestParseResult {
  manifest: PluginManifest;
  /** The directory the manifest lives in — used to resolve `entry`. */
  dir: string;
}

/**
 * Parse a raw JSON-encoded manifest. Used by the host's loader; surfaced
 * here so plugin tooling (`@squad/plugin-test`) can run the same validation
 * without depending on the gateway internals.
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  return pluginManifestSchema.parse(raw);
}

/**
 * Compare a `requires` clause (`id` or `id@range`) against a loaded id +
 * version. Returns true if the requirement is satisfied. Range parsing is
 * intentionally simple — exact equals (`=1.2.3`), prefix (`^1`, `~1.2`),
 * or no range (any version).
 */
export function satisfiesRequires(
  requires: string,
  loaded: { id: string; version: string },
): boolean {
  const at = requires.lastIndexOf("@");
  // "@scope/foo" with no range — bare id.
  if (at <= 0) return requires === loaded.id;
  const id = requires.slice(0, at);
  const range = requires.slice(at + 1);
  if (id !== loaded.id) return false;
  return rangeMatches(range, loaded.version);
}

function rangeMatches(range: string, version: string): boolean {
  if (range.length === 0) return true;
  const [vMaj, vMin, vPatch] = parseSemver(version);
  if (range.startsWith("^")) {
    const [maj] = parseSemver(range.slice(1));
    return vMaj === maj;
  }
  if (range.startsWith("~")) {
    const [maj, min] = parseSemver(range.slice(1));
    return vMaj === maj && vMin === min;
  }
  if (range.startsWith("=")) {
    return version === range.slice(1);
  }
  // Bare version → exact match.
  if (/^\d/.test(range)) {
    if (range === version) return true;
    const [maj, min, patch] = parseSemver(range);
    return maj === vMaj && min === vMin && patch === vPatch;
  }
  return false;
}

function parseSemver(s: string): [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1] ?? "0", 10), parseInt(m[2] ?? "0", 10), parseInt(m[3] ?? "0", 10)];
}
