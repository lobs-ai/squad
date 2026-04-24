/**
 * Rich rendering primitives for the REPL and one-shot commands.
 *
 * Every helper in here takes data → writes to stdout (or returns a string).
 * No state. No protocol. The REPL and subcommands call these to get a
 * consistent look regardless of which mode they're in.
 *
 * Ported in spirit from hermes_cli/banner.py + cli_output.py + display code.
 */

import type { Task, QuestionRecord, MessageRecord } from "@squad/protocol";
import { C, color, fg, stripAnsi, visibleWidth } from "./colors.js";
import { brandString, roleColor } from "./skin.js";
import { getToolFormatter } from "./tool-format.js";

// ─── low-level helpers ───────────────────────────────────────────────────────

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

function write(s: string): void {
  process.stdout.write(s);
}

/** Truncate a string to N visible columns, adding an ellipsis. */
function truncate(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  // Strip ANSI for truncation math, keep raw on short-circuit path only.
  const plain = stripAnsi(s);
  if (plain.length <= max) return s;
  return plain.slice(0, Math.max(0, max - 1)) + "…";
}

// ─── streaming & assistant messages ──────────────────────────────────────────

let _inDelta = false;

export function renderDelta(delta: string): void {
  if (!_inDelta) {
    const label = color(brandString("agent_name", "squad") + " ·", fg(roleColor("brand")), C.BOLD);
    write(`\n${label} `);
    _inDelta = true;
  }
  write(delta);
}

export function renderNewline(): void {
  write("\n");
  _inDelta = false;
}

export function renderAssistantMessage(_msg: MessageRecord): void {
  // Streaming path already flushed the text. Just reset state + newline.
  if (_inDelta) write("\n");
  _inDelta = false;
}

export function renderUserLine(prefix: string): void {
  const p = color(prefix, fg(roleColor("prompt", "#5EE1FF")), C.BOLD);
  write(`${p} `);
}

export function endDeltaBlock(): void {
  if (_inDelta) {
    write("\n");
    _inDelta = false;
  }
}

// ─── tool calls ──────────────────────────────────────────────────────────────

export type VerboseLevel = "compact" | "args" | "verbose";

function clipValue(v: unknown, max: number): string {
  if (v == null) return String(v);
  if (typeof v === "string") {
    if (v.length <= max) return JSON.stringify(v);
    return JSON.stringify(v.slice(0, max - 1) + "…");
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  } catch {
    return String(v);
  }
}

/**
 * Format tool call input. For objects, render as `key=value, key=value`
 * with per-value truncation so long paths/content don't blow out the line.
 * For everything else, fall back to a single-line JSON preview.
 */
function formatToolInput(input: unknown, level: VerboseLevel): string {
  if (level === "verbose") {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }
  const valueMax = level === "args" ? 120 : 48;
  const totalMax = level === "args" ? Math.max(80, termWidth() - 20) : 100;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length === 0) return "";
    const parts = entries.map(([k, v]) => `${k}=${clipValue(v, valueMax)}`);
    const joined = parts.join(", ");
    return truncate(joined, totalMax);
  }
  try {
    return truncate(JSON.stringify(input), totalMax);
  } catch {
    return truncate(String(input), totalMax);
  }
}

export function renderToolCall(name: string, input: unknown, level: VerboseLevel = "compact"): void {
  endDeltaBlock();
  const muted = fg(roleColor("muted", "#8A8A8A"));
  const accent = fg(roleColor("accent", "#FFB84D"));
  const arrow = color("↳", muted);
  const body = color(formatToolInput(input, level), muted);
  write(`  ${arrow} ${accent}${name}${C.RESET}${muted}(${C.RESET}${body}${muted})${C.RESET}\n`);
}

// Remember the most recent input by tool call id so result summaries that
// need the original input (e.g. write shows bytes, read shows line count)
// can reach back for it. Cleared by renderToolResult.
const lastInputByCallId = new Map<string, { name: string; input: unknown }>();

/**
 * Claude-Code-style tool call line rendered while a run is in flight.
 * Pairs with {@link renderToolResult} — the result line uses a `⎿` gutter
 * under the call so nested tool usage reads like a call-tree.
 *
 *   ⏺ read(src/foo.ts)
 *     ⎿ 142 lines
 *
 * Well-known tools get a per-tool smart label (see ./tool-format.ts); the
 * rest fall back to `key=value` pairs with per-value truncation.
 */
export function renderToolCallStart(
  name: string,
  input: unknown,
  level: VerboseLevel = "compact",
  callId?: string,
): void {
  endDeltaBlock();
  const accent = fg(roleColor("accent", "#FFB84D"));
  const muted = fg(roleColor("muted", "#8A8A8A"));
  const glyph = color("⏺", accent, C.BOLD);

  const fmt = getToolFormatter(name);
  // Verbose mode bypasses per-tool formatters — the user asked for detail.
  const argBody =
    level !== "verbose" && fmt ? fmt.args(input) : formatToolInput(input, level);

  if (callId) lastInputByCallId.set(callId, { name, input });

  // Empty arg string renders as just `⏺ tool_name` without parens.
  if (argBody) {
    write(`${glyph} ${C.BOLD}${name}${C.RESET}${muted}(${argBody})${C.RESET}\n`);
  } else {
    write(`${glyph} ${C.BOLD}${name}${C.RESET}\n`);
  }
}

/**
 * Unwrap the runner's `{ toolUseId, content }` tool-result envelope down to
 * the content the user actually wants to see. `content` may itself be a
 * string, or an array of { type: "text", text } blocks (Anthropic style).
 */
function unwrapToolResult(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  // Runner envelope from runs.ts: `{ toolUseId, content }`.
  if ("content" in obj && ("toolUseId" in obj || "tool_use_id" in obj)) {
    return unwrapToolResult(obj.content);
  }
  // Anthropic content-array: [{ type: "text", text: "..." }, ...].
  if (Array.isArray(result)) {
    const texts = result
      .map((b) => {
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          return (b as { text?: string }).text ?? "";
        }
        return "";
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }
  return result;
}

/**
 * Summarize an arbitrary tool result for the `⎿` line. Keeps the summary to
 * one line and never more than ~140 visible chars so long outputs don't push
 * the spinner off-screen.
 */
function summarizeToolResult(result: unknown, isError: boolean): string {
  const max = 140;
  const one = (s: string): string =>
    s.replace(/\s+/g, " ").trim().slice(0, max) + (s.length > max ? "…" : "");
  const unwrapped = unwrapToolResult(result);
  if (isError) {
    return "error: " + one(typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped));
  }
  if (unwrapped == null) return "done";
  if (typeof unwrapped === "string") {
    const lines = unwrapped.split(/\r?\n/).length;
    if (lines > 1) return `${lines} lines · ${one(unwrapped)}`;
    return one(unwrapped);
  }
  if (typeof unwrapped === "object") {
    const preview = one(JSON.stringify(unwrapped));
    if (preview.length < max) return preview;
    const keys = Object.keys(unwrapped as object).slice(0, 8).join(", ");
    return `{${keys}}`;
  }
  return one(String(unwrapped));
}

export function renderToolResult(
  result: unknown,
  isError: boolean,
  callId?: string,
): void {
  endDeltaBlock();
  const muted = fg(roleColor("muted", "#8A8A8A"));
  const ok = fg(roleColor("ok", "#7FD184"));
  const errColor = fg(roleColor("err", "#FF7B7B"));
  const gutter = color("  ⎿", muted);

  const unwrapped = unwrapToolResult(result);
  const recalled = callId ? lastInputByCallId.get(callId) : undefined;
  if (callId) lastInputByCallId.delete(callId);

  const fmt = recalled ? getToolFormatter(recalled.name) : null;
  let summary: string;
  if (isError) {
    summary = "error: " + (typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped));
  } else if (fmt && typeof unwrapped === "string") {
    summary = fmt.result(unwrapped, recalled?.input);
  } else {
    summary = summarizeToolResult(result, isError);
  }

  const toneOpen = isError ? errColor : ok;
  write(`${gutter} ${toneOpen}${summary}${C.RESET}\n`);
}

// ─── tasks ───────────────────────────────────────────────────────────────────

function taskGlyph(status: Task["status"]): string {
  const ok = fg(roleColor("ok", "#7FD184"));
  const warn = fg(roleColor("warn", "#FFB84D"));
  const muted = fg(roleColor("muted", "#8A8A8A"));
  switch (status) {
    case "completed":
      return color("✓", ok, C.BOLD);
    case "in_progress":
      return color("◐", warn, C.BOLD);
    case "pending":
      return color("○", muted);
    default:
      return color("·", muted);
  }
}

export function renderTaskList(tasks: Task[]): void {
  const visible = tasks.filter((t) => t.status !== "deleted");
  if (visible.length === 0) {
    write(color("  (no tasks)\n", fg(roleColor("muted"))));
    return;
  }
  const accent = fg(roleColor("accent"));
  const muted = fg(roleColor("muted"));
  write(`\n${C.BOLD}${accent}Tasks${C.RESET} ${muted}(${visible.length})${C.RESET}\n`);
  for (const t of visible) {
    const glyph = taskGlyph(t.status);
    const owner = t.owner ? color(` · ${t.owner}`, muted) : "";
    const subject = t.status === "completed" ? color(t.subject, C.DIM) : t.subject;
    write(`  ${glyph} ${subject}${owner}\n`);
  }
}

// ─── ask-user panel ──────────────────────────────────────────────────────────

export function renderAskPrompt(q: QuestionRecord): string {
  const border = fg(roleColor("question_border", "#FFB84D"));
  const accent = fg(roleColor("accent", "#FFB84D"));
  const muted = fg(roleColor("muted", "#8A8A8A"));
  const text = fg(roleColor("text", "#E8E8E8"));

  const width = Math.min(termWidth(), 100);
  const top = color("╭" + "─".repeat(width - 2) + "╮", border);
  const bot = color("╰" + "─".repeat(width - 2) + "╯", border);

  const first = q.input.questions[0]!;
  const lines: string[] = [];
  lines.push(top);
  lines.push(`${color("│", border)} ${C.BOLD}${accent}?${C.RESET} ${text}${first.question}${C.RESET}`);
  lines.push(`${color("│", border)}`);
  first.options.forEach((opt, i) => {
    const numBadge = color(`[${i + 1}]`, accent, C.BOLD);
    const label = `${text}${opt.label}${C.RESET}`;
    const desc = opt.description ? color(` — ${opt.description}`, muted) : "";
    lines.push(`${color("│", border)}   ${numBadge} ${label}${desc}`);
    if (opt.preview) {
      for (const pl of opt.preview.split("\n")) {
        lines.push(`${color("│", border)}       ${color(pl, muted, C.DIM)}`);
      }
    }
  });
  lines.push(`${color("│", border)}   ${color("[o]", accent, C.BOLD)} ${text}Other…${C.RESET} ${muted}(type a freeform answer)${C.RESET}`);
  lines.push(bot);

  return "\n" + lines.join("\n") + "\n";
}

// ─── messages ────────────────────────────────────────────────────────────────

export function renderInfo(msg: string): void {
  endDeltaBlock();
  const muted = fg(roleColor("muted"));
  write(`${muted}${msg}${C.RESET}\n`);
}

export function renderSuccess(msg: string): void {
  endDeltaBlock();
  const ok = fg(roleColor("ok"));
  write(`${ok}✓${C.RESET} ${msg}\n`);
}

export function renderWarn(msg: string): void {
  endDeltaBlock();
  const warn = fg(roleColor("warn"));
  write(`${warn}⚠${C.RESET} ${msg}\n`);
}

export function renderError(msg: string): void {
  endDeltaBlock();
  const err = fg(roleColor("err"));
  write(`${err}✗${C.RESET} ${msg}\n`);
}

export function renderHeader(text: string): void {
  endDeltaBlock();
  const accent = fg(roleColor("accent"));
  write(`\n${C.BOLD}${accent}${text}${C.RESET}\n`);
}

export function renderRule(): void {
  const border = fg(roleColor("border"));
  const w = Math.min(termWidth(), 100);
  write(color("─".repeat(w), border) + "\n");
}

export function renderDim(text: string): string {
  return color(text, C.DIM);
}

export function renderKeyValue(rows: Array<[string, string]>): void {
  const muted = fg(roleColor("muted"));
  const text = fg(roleColor("text"));
  const keyW = Math.max(0, ...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    write(`  ${muted}${k.padEnd(keyW)}${C.RESET}  ${text}${v}${C.RESET}\n`);
  }
}
