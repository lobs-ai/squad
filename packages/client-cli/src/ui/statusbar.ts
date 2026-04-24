/**
 * Soft status bar rendered just above the REPL prompt on each iteration.
 *
 * Not a true DECSTBM-protected bottom bar — implementing one in Node without
 * a TUI dep would fight with readline. The REPL calls `renderStatusbar()`
 * before every prompt so it's always visible right above the input line.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { C, bg, fg, stripAnsi } from "./colors.js";
import { roleColor } from "./skin.js";

const STATE_PATH = join(homedir(), ".squad", "statusbar");

function readInitial(): boolean {
  if (process.env.SQUAD_STATUSBAR) return process.env.SQUAD_STATUSBAR !== "0";
  if (!existsSync(STATE_PATH)) return true;
  try {
    return readFileSync(STATE_PATH, "utf8").trim() === "on";
  } catch {
    return true;
  }
}

let enabled = readInitial();

export function isStatusbarEnabled(): boolean {
  return enabled;
}

export function setStatusbarEnabled(on: boolean): void {
  enabled = on;
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, (on ? "on" : "off") + "\n");
}

export interface StatusbarState {
  sessionId: string;
  pendingQuestion: boolean;
  runningTurns?: number;
  taskCount?: number;
  openQuestions?: number;
  gatewayUrl?: string;
}

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

function padTo(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/** Render the bar as one full-width line. Caller writes it to stdout. */
export function buildStatusbar(s: StatusbarState): string {
  if (!enabled) return "";

  const bgCode = bg(roleColor("status_bg", "#0F1B26"));
  const text = fg(roleColor("status_text", "#C0C0C0"));
  const strong = fg(roleColor("status_strong", "#FFD27F"));
  const warn = fg(roleColor("warn", "#FFB84D"));

  const sep = `${text} · ${C.RESET}`;
  const pieces: string[] = [];
  pieces.push(`${strong}squad${C.RESET}`);
  pieces.push(`${text}session ${strong}${s.sessionId.slice(0, 8)}${C.RESET}`);
  if (typeof s.taskCount === "number") {
    pieces.push(`${text}tasks ${strong}${s.taskCount}${C.RESET}`);
  }
  if (typeof s.openQuestions === "number" && s.openQuestions > 0) {
    pieces.push(`${warn}? ${s.openQuestions} open${C.RESET}`);
  } else if (s.pendingQuestion) {
    pieces.push(`${warn}? awaiting answer${C.RESET}`);
  }
  if (s.runningTurns) {
    pieces.push(`${warn}running${C.RESET}`);
  }
  const body = pieces.join(sep);
  const line = padTo(` ${body} `, termWidth());
  return `${bgCode}${line}${C.RESET}\n`;
}

/** Convenience: print the bar directly. */
export function renderStatusbar(s: StatusbarState): void {
  const line = buildStatusbar(s);
  if (line) process.stdout.write(line);
}
