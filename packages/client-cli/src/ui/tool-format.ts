/**
 * Per-tool smart formatters for the REPL's live tool display.
 *
 * For each well-known tool:
 *   - `args(input)` returns a short, human-readable description of the call
 *     ("src/foo.ts", "path: . · glob: **\/*.md", etc).
 *   - `result(content, input)` summarizes what happened — typically a count
 *     or a one-line snippet, not the raw blob.
 *
 * Unknown tools fall back to the generic formatters in ./render.ts.
 */

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as AnyObj) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Collapse long absolute paths to `…/tail` when they're longer than `max`.
 * Matches how hermes / claude-code display file paths in the activity feed.
 */
function shortPath(p: string, max = 60): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  // Keep the last two segments, prefix with ellipsis.
  if (parts.length <= 2) return "…" + p.slice(-max);
  const tail = parts.slice(-2).join("/");
  if (tail.length >= max - 2) return "…/" + tail.slice(-(max - 2));
  return "…/" + tail;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split(/\r?\n/).filter(Boolean).length;
}

function firstLine(s: string, max = 120): string {
  const first = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

export interface ToolFormatter {
  args(input: unknown): string;
  result(content: string, input: unknown): string;
}

/**
 * Generic args formatter: pick the most useful named field, else empty.
 * Used as a per-tool `args` when the tool just echoes its primary argument.
 */
function primaryArg(
  keys: string[],
  suffix?: (obj: AnyObj) => string,
): (input: unknown) => string {
  return (input) => {
    const obj = asObj(input);
    if (!obj) return "";
    for (const k of keys) {
      const v = str(obj[k]);
      if (v !== undefined) return suffix ? `${v}${suffix(obj) || ""}` : v;
    }
    return "";
  };
}

const REGISTRY: Record<string, ToolFormatter> = {
  // ── filesystem ─────────────────────────────────────────────────────────
  ls: {
    args: primaryArg(["path", "dir", "directory"]),
    result: (content) => {
      const n = countLines(content);
      if (!n) return "empty";
      return `${n} ${n === 1 ? "entry" : "entries"}`;
    },
  },
  read: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const path = str(obj.file_path) ?? str(obj.path) ?? "";
      const offset = typeof obj.offset === "number" ? obj.offset : null;
      const limit = typeof obj.limit === "number" ? obj.limit : null;
      const range =
        offset !== null || limit !== null
          ? ` :${offset ?? 0}${limit !== null ? "+" + limit : ""}`
          : "";
      return shortPath(path, 60) + range;
    },
    result: (content) => {
      const n = countLines(content);
      if (!n) return "empty file";
      return `${n} line${n === 1 ? "" : "s"}`;
    },
  },
  write: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const path = str(obj.file_path) ?? str(obj.path) ?? "";
      const content = str(obj.content) ?? "";
      const bytes = content.length;
      const bytesStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`;
      return `${shortPath(path, 50)} (${bytesStr})`;
    },
    result: (content) => firstLine(content, 80) || "wrote file",
  },
  edit: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const path = str(obj.file_path) ?? str(obj.path) ?? "";
      return shortPath(path, 60);
    },
    result: (content) => firstLine(content, 100) || "edited",
  },

  // ── search ─────────────────────────────────────────────────────────────
  glob: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const pattern = str(obj.glob) ?? str(obj.pattern) ?? "";
      const path = str(obj.path);
      return path ? `${pattern} in ${shortPath(path, 40)}` : pattern;
    },
    result: (content) => {
      const m = /Found (\d+) files?/.exec(content);
      if (m) return `${m[1]} match${m[1] === "1" ? "" : "es"}`;
      const n = countLines(content);
      return n ? `${n} match${n === 1 ? "" : "es"}` : "no matches";
    },
  },
  "code-search": {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const pattern = str(obj.pattern) ?? str(obj.query) ?? "";
      const path = str(obj.path);
      return path ? `"${pattern}" in ${shortPath(path, 40)}` : `"${pattern}"`;
    },
    result: (content) => {
      const m = /(\d+) match(?:es)?/.exec(content);
      if (m) return `${m[1]} match${m[1] === "1" ? "" : "es"}`;
      const n = countLines(content);
      return n ? `${n} hit${n === 1 ? "" : "s"}` : "no matches";
    },
  },
  grep: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const pattern = str(obj.pattern) ?? str(obj.query) ?? "";
      return `"${pattern}"`;
    },
    result: (content) => {
      const n = countLines(content);
      return n ? `${n} match${n === 1 ? "" : "es"}` : "no matches";
    },
  },

  // ── shell ──────────────────────────────────────────────────────────────
  exec: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      return str(obj.cmd) ?? str(obj.command) ?? "";
    },
    result: (content) => firstLine(content, 140) || "(no output)",
  },
  Bash: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      return str(obj.cmd) ?? str(obj.command) ?? "";
    },
    result: (content) => firstLine(content, 140) || "(no output)",
  },

  // ── web ────────────────────────────────────────────────────────────────
  web_fetch: {
    args: primaryArg(["href", "url"]),
    result: (content) => {
      const bytes = content.length;
      const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`;
      return `${size} · ${firstLine(content, 80)}`;
    },
  },
  web_search: {
    args: primaryArg(["query", "q"]),
    result: (content) => {
      const n = countLines(content);
      return n ? `${n} result${n === 1 ? "" : "s"}` : "no results";
    },
  },

  // ── squad-native tools ────────────────────────────────────────────────
  get_config: {
    args: primaryArg(["path", "key"]),
    result: (content) => {
      try {
        const o = JSON.parse(content) as AnyObj;
        if ("value" in o) return `= ${JSON.stringify(o.value)}`;
      } catch {
        // fall through
      }
      return firstLine(content, 80);
    },
  },
  set_config: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const k = str(obj.path) ?? str(obj.key) ?? "";
      const v = obj.value;
      return `${k} = ${JSON.stringify(v)}`;
    },
    result: () => "updated",
  },
  list_config_paths: {
    args: () => "",
    result: (content) => {
      const n = countLines(content);
      return `${n} path${n === 1 ? "" : "s"}`;
    },
  },
  list_tasks: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj || Object.keys(obj).length === 0) return "";
      return str(obj.status) ?? "";
    },
    result: (content) => {
      try {
        const parsed = JSON.parse(content) as { tasks?: unknown[] };
        const n = parsed.tasks?.length ?? 0;
        return `${n} task${n === 1 ? "" : "s"}`;
      } catch {
        return "listed";
      }
    },
  },
  create_task: {
    args: primaryArg(["subject", "title"]),
    result: () => "created",
  },
  update_task: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const id = str(obj.taskId) ?? str(obj.id) ?? "";
      const status = str(obj.status);
      return status ? `${id.slice(0, 8)} → ${status}` : id.slice(0, 8);
    },
    result: () => "updated",
  },
  ask_user: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      if (Array.isArray(obj.questions) && obj.questions.length > 0) {
        const first = asObj(obj.questions[0]);
        return str(first?.question) ?? "(question)";
      }
      return "";
    },
    result: () => "awaiting answer",
  },
  spawn_subagent: {
    args: (input) => {
      const obj = asObj(input);
      if (!obj) return "";
      const subagent = str(obj.subagent) ?? str(obj.id) ?? "";
      const task = str(obj.task) ?? "";
      return task ? `${subagent}: ${firstLine(task, 60)}` : subagent;
    },
    result: () => "spawned",
  },

  // ── misc / docs ────────────────────────────────────────────────────────
  html_style_guide: {
    args: primaryArg(["section", "topic"]),
    result: (content) => {
      const n = countLines(content);
      return `${n} line${n === 1 ? "" : "s"}`;
    },
  },
};

export function getToolFormatter(name: string): ToolFormatter | null {
  return REGISTRY[name] ?? null;
}
