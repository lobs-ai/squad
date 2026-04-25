import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { MemoryEntry, MemoryType, MemoryScope, MemoryStatus } from "./types.js";

/**
 * Resolve the memory directory.
 *
 * Order of precedence:
 *   1. SQUAD_MEMORY_DIR env var (absolute or relative to cwd)
 *   2. configured value (absolute or relative to cwd)
 *   3. ${HOME}/.squad/memory
 *
 * Deliberately NOT under workspace_dir or data_dir — memory is durable user
 * state that should outlive a docker re-roll. Bind-mount it explicitly if you
 * want it inside a container.
 */
export function resolveMemoryDir(configured?: string): string {
  const fromEnv = process.env.SQUAD_MEMORY_DIR;
  const raw = fromEnv?.trim() || configured?.trim() || join(homedir(), ".squad", "memory");
  return isAbsolute(raw) ? raw : resolvePath(process.cwd(), raw);
}

export function ensureMemoryDir(memoryDir: string): void {
  mkdirSync(join(memoryDir, "entries"), { recursive: true });
}

export interface EntryFrontmatter {
  id: string;
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  scopeKey?: string | null;
  status: MemoryStatus;
  confidence: number;
  description: string;
  createdAt: string;
  updatedAt: string;
  provenanceSessionId?: string | null;
  provenanceAgentId?: string | null;
}

const FRONTMATTER_DELIM = "---";

/**
 * Render a memory entry as its on-disk markdown representation. The format is
 * deliberately git-friendly: YAML-ish frontmatter (subset — we parse it
 * by hand to avoid a dep), then the body verbatim.
 */
export function renderEntryFile(entry: MemoryEntry): string {
  const lines: string[] = [
    FRONTMATTER_DELIM,
    `id: ${entry.id}`,
    `name: ${escapeScalar(entry.name)}`,
    `type: ${entry.type}`,
    `scope: ${entry.scope}`,
    `scope_key: ${entry.scopeKey === null ? "" : escapeScalar(entry.scopeKey)}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    `description: ${escapeScalar(entry.description)}`,
    `created_at: ${entry.createdAt}`,
    `updated_at: ${entry.updatedAt}`,
    `provenance_session_id: ${entry.provenanceSessionId ?? ""}`,
    `provenance_agent_id: ${entry.provenanceAgentId ?? ""}`,
    FRONTMATTER_DELIM,
    "",
    entry.body.trimEnd(),
    "",
  ];
  return lines.join("\n");
}

/** Parse a previously written entry file. Strict — anything malformed throws. */
export function parseEntryFile(text: string): {
  frontmatter: EntryFrontmatter;
  body: string;
} {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new Error("memory entry: missing leading frontmatter delimiter");
  }
  let i = 1;
  const fm: Record<string, string> = {};
  while (i < lines.length && lines[i]?.trim() !== FRONTMATTER_DELIM) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fm[key] = unescapeScalar(value);
    i++;
  }
  if (i >= lines.length) {
    throw new Error("memory entry: missing closing frontmatter delimiter");
  }
  const body = lines.slice(i + 1).join("\n").replace(/^\n+/, "").trimEnd();
  const frontmatter: EntryFrontmatter = {
    id: required(fm, "id"),
    name: required(fm, "name"),
    type: required(fm, "type") as MemoryType,
    scope: required(fm, "scope") as MemoryScope,
    scopeKey: fm.scope_key === undefined || fm.scope_key === "" ? null : fm.scope_key,
    status: (fm.status ?? "active") as MemoryStatus,
    confidence: Number(fm.confidence ?? "50"),
    description: required(fm, "description"),
    createdAt: required(fm, "created_at"),
    updatedAt: required(fm, "updated_at"),
    provenanceSessionId:
      fm.provenance_session_id === undefined || fm.provenance_session_id === ""
        ? null
        : fm.provenance_session_id,
    provenanceAgentId:
      fm.provenance_agent_id === undefined || fm.provenance_agent_id === ""
        ? null
        : fm.provenance_agent_id,
  };
  return { frontmatter, body };
}

function required(fm: Record<string, string>, key: string): string {
  const v = fm[key];
  if (v === undefined) throw new Error(`memory entry: missing required field "${key}"`);
  return v;
}

function escapeScalar(value: string): string {
  if (value.includes("\n")) {
    throw new Error("memory frontmatter scalars cannot contain newlines");
  }
  // Quote if the value would otherwise be ambiguous (leading/trailing space,
  // colon, or starts with a YAML reserved char). We don't aim for full YAML
  // round-trip — just enough that the parser above stays correct.
  if (/^\s|\s$|: |^[#&*!|>'"%@`-]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function unescapeScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}

/** Slug a name into a safe filename stem. */
export function slugForEntry(type: string, name: string): string {
  const base = `${type}_${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return base || "entry";
}

/** Pick a unique file path under entries/ — appends -2/-3/... on collision. */
export function uniqueEntryPath(memoryDir: string, slug: string): string {
  const dir = join(memoryDir, "entries");
  let candidate = join(dir, `${slug}.md`);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${slug}-${n}.md`);
    n++;
  }
  return candidate;
}

export function writeEntryFile(entry: MemoryEntry): void {
  writeFileSync(entry.filePath, renderEntryFile(entry));
}

export function readEntryFile(filePath: string): { frontmatter: EntryFrontmatter; body: string } {
  return parseEntryFile(readFileSync(filePath, "utf8"));
}

export function deleteEntryFile(filePath: string): void {
  if (existsSync(filePath)) unlinkSync(filePath);
}

/**
 * The MEMORY.md index — one line per active entry, grouped by type. Rebuilt
 * from scratch every time something changes. Cheap (kilobytes) and avoids
 * incremental-update bugs.
 */
export function renderIndex(entries: MemoryEntry[]): string {
  const active = entries.filter((e) => e.status === "active");
  if (active.length === 0) {
    return [
      "# MEMORY index",
      "",
      "_Empty. The agent writes typed entries here via `memory_propose`._",
      "",
    ].join("\n");
  }
  const byType = new Map<string, MemoryEntry[]>();
  for (const e of active) {
    const arr = byType.get(e.type) ?? [];
    arr.push(e);
    byType.set(e.type, arr);
  }
  const sectionOrder: MemoryType[] = ["user", "feedback", "project", "reference", "working"];
  const lines: string[] = ["# MEMORY index", ""];
  for (const t of sectionOrder) {
    const list = byType.get(t);
    if (!list || list.length === 0) continue;
    lines.push(`## ${t}`);
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      const rel = `entries/${e.filePath.split("/").pop()}`;
      lines.push(`- [${e.name}](${rel}) — ${truncate(e.description, 120)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

export function writeIndex(memoryDir: string, entries: MemoryEntry[]): void {
  writeFileSync(join(memoryDir, "MEMORY.md"), renderIndex(entries));
}

/** List all `.md` files under entries/ — used to rehydrate the SQLite index. */
export function listEntryFiles(memoryDir: string): string[] {
  const dir = join(memoryDir, "entries");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
}
