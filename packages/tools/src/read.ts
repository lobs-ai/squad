/**
 * Read tool — read file contents.
 *
 * Supports offset/limit for large files, binary detection, device file
 * blocking, and a read-snapshot cache used by the Edit tool to enforce
 * must-read-before-edit.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import type { ToolDefinition } from "./types.js";
import { resolveToCwd } from "./path-utils.js";
import { BaseTool, type ToolContext } from "./base-tool.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const readToolDefinition: ToolDefinition = {
  name: "read",
  description:
    "Reads a file from the local filesystem. Assume any user-provided path is worth checking. " +
    "Use an absolute path via file_path when possible. By default it reads from the start of the file and returns line-numbered text. " +
    "When you already know the area you need, use offset and limit for a targeted read instead of re-reading the whole file. " +
    "This tool reads files only, not directories.",
  input_schema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
      path: {
        type: "string",
        description: "Backward-compatible path field; file_path is preferred",
      },
      offset: {
        type: "number",
        description: "Optional 1-based line number to start reading from",
      },
      limit: {
        type: "number",
        description: "Optional maximum number of lines to read",
      },
      full: {
        type: "boolean",
        description: "Return the entire file without truncation (fails for files > 200KB)",
      },
    },
    required: [],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LINES = 2000;
const DEFAULT_LINES = 500;
const MAX_BYTES = 50 * 1024;
const DEFAULT_BYTES = 50_000;
const BINARY_CHECK_BYTES = 8192;
const MAX_FULL_FILE_BYTES = 200 * 1024;

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero", "/dev/random", "/dev/urandom",
  "/dev/full", "/dev/stdin", "/dev/tty", "/dev/console",
]);

// ── Read Snapshot Cache ──────────────────────────────────────────────────────

export interface ReadSnapshot {
  mtimeMs: number;
  size: number;
  contentHash: string;
}

export const recentReadCache = new Map<string, ReadSnapshot>();
export const recentlyReadFiles = new Set<string>();
export const recentReadPaths = new Map<string, Set<string>>();

function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

export function createReadSnapshot(content: string, mtimeMs: number, size: number): ReadSnapshot {
  return { mtimeMs, size, contentHash: hashContent(content) };
}

function getOrCreateReadPathSet(resolved: string): Set<string> {
  let set = recentReadPaths.get(resolved);
  if (!set) {
    set = new Set<string>();
    recentReadPaths.set(resolved, set);
  }
  return set;
}

/**
 * Returns true if the file has been recently read (and not changed since).
 */
export function hasRecentlyReadFile(filePath: string, cwd: string): boolean {
  const resolved = resolveToCwd(filePath, cwd);
  if (recentlyReadFiles.has(resolved)) return true;
  const aliases = recentReadPaths.get(resolved);
  if (aliases && aliases.has(filePath)) return true;
  return false;
}

/**
 * Get the read snapshot for a resolved path (checks all cache variants).
 */
export function getReadSnapshot(resolvedPath: string): ReadSnapshot | null {
  for (const [key, value] of recentReadCache) {
    if (key.startsWith(`${resolvedPath}:`)) return value;
  }
  return null;
}

/**
 * Update snapshots after the file has been written/edited.
 */
export function updateReadSnapshot(resolvedPath: string, content: string, mtimeMs: number, size: number): void {
  const snapshot = createReadSnapshot(content, mtimeMs, size);
  for (const key of recentReadCache.keys()) {
    if (key.startsWith(`${resolvedPath}:`)) {
      recentReadCache.set(key, snapshot);
    }
  }
  recentlyReadFiles.add(resolvedPath);
}

/** Clear all read tracking (useful in tests). */
export function clearRecentReadTracking(): void {
  recentReadCache.clear();
  recentlyReadFiles.clear();
  recentReadPaths.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, Math.min(BINARY_CHECK_BYTES, buffer.length));
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true;
  }
  return false;
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function readTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const filePath = (params.file_path as string) ?? (params.path as string);
  if (!filePath) throw new Error("file_path is required");

  const resolved = resolveToCwd(filePath, cwd);

  if (BLOCKED_DEVICE_PATHS.has(resolved)) {
    throw new Error("Cannot read device file — would block or produce infinite output.");
  }

  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`${filePath} is a directory, not a file. Use the ls tool instead.`);
  }

  const buffer = readFileSync(resolved);

  if (isBinary(buffer)) {
    recentlyReadFiles.add(resolved);
    return `Binary file (${stat.size} bytes): ${filePath}`;
  }

  const content = buffer.toString("utf-8");
  const lines = content.split("\n");
  const full = params.full === true;
  const hasExplicitRange =
    typeof params.offset === "number" || typeof params.limit === "number";
  const offset = typeof params.offset === "number" ? Math.max(1, params.offset) : 1;
  const limit = typeof params.limit === "number"
    ? Math.max(1, params.limit)
    : hasExplicitRange ? MAX_LINES : DEFAULT_LINES;

  const cacheKey = `${resolved}:${full ? "full" : `${offset}:${limit}`}`;
  const currentSnapshot = createReadSnapshot(content, stat.mtimeMs, stat.size);

  if (full) {
    if (stat.size > MAX_FULL_FILE_BYTES) {
      throw new Error(
        `File too large for full read (${stat.size} bytes). Use offset/limit for large files.`,
      );
    }
    recentlyReadFiles.add(resolved);
    getOrCreateReadPathSet(resolved).add(filePath);
    recentReadCache.set(cacheKey, currentSnapshot);
    return content;
  }

  const byteBudget = hasExplicitRange ? MAX_BYTES : DEFAULT_BYTES;
  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, lines.length);
  const sliced = lines.slice(startIdx, endIdx);

  let result = sliced
    .map((line, i) => `${String(startIdx + i + 1).padStart(6, " ")}\t${line}`)
    .join("\n");

  if (Buffer.byteLength(result) > byteBudget) {
    const truncated = result.slice(0, byteBudget);
    const lastNl = truncated.lastIndexOf("\n");
    result = lastNl > byteBudget * 0.7 ? truncated.slice(0, lastNl) : truncated;
    const shownLines = result.split("\n").length;
    const from = offset + shownLines;
    result += `\n\n[Truncated. ${lines.length - (startIdx + shownLines)} more lines. Use offset=${from} to continue.]`;
    recentlyReadFiles.add(resolved);
    getOrCreateReadPathSet(resolved).add(filePath);
    recentReadCache.set(cacheKey, currentSnapshot);
    return result;
  }

  const meta: string[] = [];
  if (startIdx > 0 || endIdx < lines.length) {
    meta.push(`Lines ${offset}–${endIdx} of ${lines.length}`);
  }
  if (endIdx < lines.length) {
    meta.push(`${lines.length - endIdx} more lines. Use offset=${endIdx + 1} to continue.`);
  }

  const finalResult = meta.length > 0 ? `${result}\n\n[${meta.join(". ")}]` : result;
  recentlyReadFiles.add(resolved);
  getOrCreateReadPathSet(resolved).add(filePath);
  recentReadCache.set(cacheKey, currentSnapshot);
  return finalResult;
}

// ── Class-based API ──────────────────────────────────────────────────────────

export class ReadTool extends BaseTool {
  readonly name = "read";
  readonly tags = ["filesystem", "readonly"] as const;
  readonly description = readToolDefinition.description;
  readonly inputSchema = readToolDefinition.input_schema as import("./base-tool.js").ToolInputSchema;

  run(params: Record<string, unknown>, ctx: ToolContext) {
    return readTool(params, ctx.cwd);
  }
}
