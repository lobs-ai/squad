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
  /** Cumulative tokens for the active session (input/output). */
  tokensIn?: number;
  tokensOut?: number;
  /** Active subagent count for the session tree. */
  activeSubagents?: number;
  /** Pending approvals waiting for the operator. */
  pendingApprovals?: number;
}

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

function padTo(text: string, width: number): string {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/** Render the bar as one or two full-width lines. Caller writes it to stdout. */
export function buildStatusbar(s: StatusbarState): string {
  if (!enabled) return "";

  const bgCode = bg(roleColor("status_bg", "#0F1B26"));
  const text = fg(roleColor("status_text", "#C0C0C0"));
  const strong = fg(roleColor("status_strong", "#FFD27F"));
  const warn = fg(roleColor("warn", "#FFB84D"));

  const sep = `${text} · ${C.RESET}`;

  // ── Top line: identity + counters ──────────────────────────────────────
  const topPieces: string[] = [];
  topPieces.push(`${strong}squad${C.RESET}`);
  topPieces.push(`${text}session ${strong}${s.sessionId.slice(0, 8)}${C.RESET}`);
  if (typeof s.taskCount === "number") {
    topPieces.push(`${text}tasks ${strong}${s.taskCount}${C.RESET}`);
  }
  if (typeof s.openQuestions === "number" && s.openQuestions > 0) {
    topPieces.push(`${warn}? ${s.openQuestions} open${C.RESET}`);
  } else if (s.pendingQuestion) {
    topPieces.push(`${warn}? awaiting answer${C.RESET}`);
  }
  if (typeof s.pendingApprovals === "number" && s.pendingApprovals > 0) {
    topPieces.push(`${warn}🔒 ${s.pendingApprovals} approval(s)${C.RESET}`);
  }
  if (s.runningTurns) {
    topPieces.push(`${warn}running${C.RESET}`);
  }
  const topBody = topPieces.join(sep);
  const topLine = padTo(` ${topBody} `, termWidth());

  // ── Bottom line: token usage + active subagents ────────────────────────
  // Suppressed when there's nothing interesting to report — keeps the bar
  // single-line for fresh sessions.
  const hasTokens =
    typeof s.tokensIn === "number" || typeof s.tokensOut === "number";
  const hasSub = typeof s.activeSubagents === "number" && s.activeSubagents > 0;
  if (!hasTokens && !hasSub) {
    return `${bgCode}${topLine}${C.RESET}\n`;
  }
  const bottomPieces: string[] = [];
  if (hasTokens) {
    const tIn = (s.tokensIn ?? 0).toLocaleString();
    const tOut = (s.tokensOut ?? 0).toLocaleString();
    bottomPieces.push(`${text}tokens ${strong}${tIn}${C.RESET}${text}↦${strong}${tOut}${C.RESET}`);
  }
  if (hasSub) {
    bottomPieces.push(
      `${text}subagents ${strong}${s.activeSubagents}${C.RESET}${text} active${C.RESET}`,
    );
  }
  const bottomBody = bottomPieces.join(sep);
  const bottomLine = padTo(` ${bottomBody} `, termWidth());
  return `${bgCode}${topLine}${C.RESET}\n${bgCode}${bottomLine}${C.RESET}\n`;
}

/** Convenience: print the bar directly. */
export function renderStatusbar(s: StatusbarState): void {
  const line = buildStatusbar(s);
  if (line) process.stdout.write(line);
}
