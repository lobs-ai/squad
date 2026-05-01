import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";

/**
 * Files we look for when walking up from the agent's cwd. Order is the priority
 * order — earlier entries win when the same directory contains multiple files
 * (e.g. both AGENTS.md and CLAUDE.md). Files closer to cwd always beat the same
 * file higher up the tree.
 */
export const CONTEXT_FILE_NAMES = [
  "SQUAD.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
] as const;

export type ContextFileName = (typeof CONTEXT_FILE_NAMES)[number];

export interface DiscoveredContextFile {
  path: string;
  /** Filename component (one of CONTEXT_FILE_NAMES). */
  name: ContextFileName;
  /** Distance from cwd in directory hops. cwd = 0, parent = 1, etc. */
  distance: number;
  body: string;
  /** Approximate token count using a 4-char heuristic. */
  tokens: number;
}

export interface DiscoverOptions {
  /** Hard ceiling for total tokens across all returned files. */
  tokenBudget?: number;
  /** How far up the tree to walk. Defaults to root. */
  maxDepth?: number;
  /** Names to look for. Override for tests; defaults to CONTEXT_FILE_NAMES. */
  names?: readonly string[];
}

const DEFAULT_TOKEN_BUDGET = 8000;

/**
 * Walk up from `cwd` collecting context files. Dedup so that if a parent dir
 * has the same file as a child (rare but legal), the closer copy wins. Cap
 * total token output at `tokenBudget`; when over, drop the *farthest* files
 * first — keeping the closest-to-cwd ones is the spec.
 */
export function discoverContextFiles(
  cwd: string,
  opts: DiscoverOptions = {},
): DiscoveredContextFile[] {
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxDepth = opts.maxDepth ?? 32;
  const names = opts.names ?? CONTEXT_FILE_NAMES;

  const seenNames = new Set<string>();
  const found: DiscoveredContextFile[] = [];

  let current = resolvePath(cwd);
  let depth = 0;
  while (depth <= maxDepth) {
    for (const fileName of names) {
      if (seenNames.has(fileName)) continue;
      const candidate = join(current, fileName);
      if (!existsSync(candidate)) continue;
      const stat = (() => {
        try {
          return statSync(candidate);
        } catch {
          return null;
        }
      })();
      if (!stat || !stat.isFile()) continue;
      let body = "";
      try {
        body = readFileSync(candidate, "utf8");
      } catch {
        continue;
      }
      const trimmed = body.trim();
      if (trimmed.length === 0) continue;
      seenNames.add(fileName);
      found.push({
        path: candidate,
        name: fileName as ContextFileName,
        distance: depth,
        body: trimmed,
        tokens: estimateTokens(trimmed),
      });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    depth++;
  }

  // Sort closest-to-cwd first so they get budget priority.
  found.sort((a, b) => a.distance - b.distance);

  let total = 0;
  const kept: DiscoveredContextFile[] = [];
  for (const f of found) {
    if (total + f.tokens > tokenBudget) continue;
    kept.push(f);
    total += f.tokens;
  }
  return kept;
}

/**
 * Walk *down* from a base cwd into a subdirectory and return any context files
 * that live strictly between `cwd` and `subdir`. Used by progressive discovery
 * — when the agent cd's into a subtree, we inject just the new files without
 * re-injecting the ones already loaded from the original cwd.
 */
export function discoverProgressiveContextFiles(
  baseCwd: string,
  subdir: string,
  opts: DiscoverOptions = {},
): DiscoveredContextFile[] {
  const base = resolvePath(baseCwd);
  const target = resolvePath(subdir);
  if (!target.startsWith(base + sep) && target !== base) return [];

  const names = opts.names ?? CONTEXT_FILE_NAMES;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const found: DiscoveredContextFile[] = [];

  // Walk from target up to (but not including) base.
  let current = target;
  let depth = 0;
  while (current !== base) {
    for (const fileName of names) {
      const candidate = join(current, fileName);
      if (!existsSync(candidate)) continue;
      let body = "";
      try {
        body = readFileSync(candidate, "utf8");
      } catch {
        continue;
      }
      const trimmed = body.trim();
      if (trimmed.length === 0) continue;
      found.push({
        path: candidate,
        name: fileName as ContextFileName,
        distance: depth,
        body: trimmed,
        tokens: estimateTokens(trimmed),
      });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    depth++;
  }

  found.sort((a, b) => a.distance - b.distance);

  let total = 0;
  const kept: DiscoveredContextFile[] = [];
  for (const f of found) {
    if (total + f.tokens > tokenBudget) continue;
    kept.push(f);
    total += f.tokens;
  }
  return kept;
}

/**
 * Render discovered context files into a single markdown section suitable for
 * injection into the system prompt. Returns the empty string when there are
 * no files to render so callers can drop the section without nullable juggling.
 */
export function renderContextFilesSection(files: DiscoveredContextFile[]): string {
  if (files.length === 0) return "";
  const parts: string[] = [
    "## Project context files",
    "",
    "_Files discovered by walking up from your working directory. Treat these as standing instructions from the project — closer files outrank farther ones._",
    "",
  ];
  for (const f of files) {
    parts.push(`### ${f.path}`);
    parts.push("");
    parts.push(f.body);
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

function estimateTokens(s: string): number {
  // Rough 4-chars-per-token heuristic. Off by ~20% for code-heavy content but
  // good enough for budgeting; the alternative is shipping a tokenizer per
  // provider just to count words.
  return Math.ceil(s.length / 4);
}
