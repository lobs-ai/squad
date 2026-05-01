import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "./types.js";
import type { Logger } from "../logger.js";

/**
 * Markdown mirror: every memory write also lands as a `.md` file under
 * `<dataDir>/memory/`. Lets users read, grep, version, and back up their
 * memory store outside the Postgres-backed MemCore. The DB stays the source
 * of truth — the mirror is best-effort and recoverable from DB on next boot.
 *
 * Frontmatter header:
 *
 *   ---
 *   id: mem_xxx
 *   type: user
 *   name: short-name
 *   description: one-liner
 *   updatedAt: 2026-04-30T...
 *   ---
 *
 * Body is the memory's `body` field verbatim.
 */
export class MarkdownMemoryMirror {
  private readonly dir: string;
  constructor(dataDir: string, private readonly logger: Logger) {
    this.dir = join(dataDir, "memory");
  }

  /** Absolute path of the mirror directory. Used when surfacing the location
   * to the agent (system prompt) or to ops tooling. */
  getDir(): string {
    return this.dir;
  }

  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Write/replace the .md file for a single entry. Best-effort, never throws. */
  upsert(entry: MemoryEntry): void {
    try {
      this.ensureDir();
      const path = this.pathFor(entry.id);
      const body = renderEntry(entry);
      const tmp = path + ".tmp";
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (err) {
      this.logger.warn({ err, id: entry.id }, "markdown memory mirror write failed");
    }
  }

  /** Remove the .md file. Best-effort. */
  remove(id: string): void {
    try {
      const path = this.pathFor(id);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      this.logger.warn({ err, id }, "markdown memory mirror delete failed");
    }
  }

  /**
   * Read every .md file in the mirror dir and return parsed entries. Used
   * at boot to detect external edits — when a file's body differs from the
   * DB row, callers can re-upsert via the MemoryService.
   */
  loadAll(): Array<{
    id: string;
    type: string;
    name: string;
    description: string;
    body: string;
    updatedAt: string;
  }> {
    if (!existsSync(this.dir)) return [];
    const out: ReturnType<MarkdownMemoryMirror["loadAll"]> = [];
    for (const fname of readdirSync(this.dir)) {
      if (!fname.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(this.dir, fname), "utf8");
        const parsed = parseEntry(raw);
        if (parsed) out.push(parsed);
      } catch (err) {
        this.logger.warn({ err, file: fname }, "markdown memory mirror parse failed");
      }
    }
    return out;
  }

  private pathFor(id: string): string {
    // ids are short (mem_xxxx); using id directly as filename is safe.
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.dir, `${safe}.md`);
  }
}

function renderEntry(entry: MemoryEntry): string {
  const lines = [
    "---",
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `name: ${escapeYamlScalar(entry.name)}`,
    `description: ${escapeYamlScalar(entry.description ?? "")}`,
    `updatedAt: ${entry.updatedAt}`,
    "---",
    "",
    entry.body.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

function escapeYamlScalar(s: string): string {
  if (/^[\w\s.-]*$/.test(s)) return s;
  // Quote + escape backslash and double quote.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseEntry(raw: string): {
  id: string;
  type: string;
  name: string;
  description: string;
  body: string;
  updatedAt: string;
} | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const front = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "").trimEnd();
  const fields: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (m) fields[m[1]!] = unquoteYamlScalar(m[2]!);
  }
  if (!fields.id || !fields.type || !fields.name) return null;
  return {
    id: fields.id,
    type: fields.type,
    name: fields.name,
    description: fields.description ?? "",
    updatedAt: fields.updatedAt ?? new Date().toISOString(),
    body,
  };
}

function unquoteYamlScalar(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}
