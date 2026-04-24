/**
 * Welcome banner: ASCII wordmark, session/gateway info, optional update hint.
 * Mirrors hermes_cli/banner.py build_welcome_banner but scoped to squad's
 * actual surface — no tools/skills matrix to render yet.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { C, color, fg, stripAnsi, visibleWidth } from "./colors.js";
import { brandString, getActiveSkin, roleColor } from "./skin.js";

// Block wordmark. Works at 80+ cols; we fall back to a compact banner narrower.
const SQUAD_LOGO = [
  " ███████╗ ██████╗ ██╗   ██╗ █████╗ ██████╗",
  " ██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔══██╗",
  " ███████╗██║   ██║██║   ██║███████║██║  ██║",
  " ╚════██║██║▄▄ ██║██║   ██║██╔══██║██║  ██║",
  " ███████║╚██████╔╝╚██████╔╝██║  ██║██████╔╝",
  " ╚══════╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝",
];

// Compact single-line mark for narrow terminals.
const SQUAD_COMPACT = "░▒▓█ SQUAD █▓▒░";

// Five-node formation — parent + 4 subagents. Rendered to the right of info.
const SQUAD_HERO = [
  "      ◆",
  "    ╱ │ ╲",
  "   ◆  ◆  ◆",
  "        ╲",
  "         ◆",
];

export interface BannerInfo {
  version: string;
  gatewayUrl: string;
  sessionId?: string;
  cwd?: string;
  tokenSet: boolean;
  tip?: string;
}

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ui/banner.js → ../../package.json; src/ui/banner.ts → ../../package.json
    for (const rel of ["../../package.json", "../../../package.json"]) {
      const p = join(here, rel);
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // ignore — version is cosmetic
  }
  return "0.0.0";
}

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Colored logo lines. Uses a single brand color so the wordmark reads evenly. */
function renderLogo(): string[] {
  const brand = fg(roleColor("brand", "#5EE1FF"));
  return SQUAD_LOGO.map((line) => `${brand}${C.BOLD}${line}${C.RESET}`);
}

function renderHero(): string[] {
  const accent = fg(roleColor("accent", "#FFB84D"));
  const dim = fg(roleColor("accent_dim", "#B87A1A"));
  return SQUAD_HERO.map((line, i) => {
    const tone = i % 2 === 0 ? accent : dim;
    return `${tone}${line}${C.RESET}`;
  });
}

/** Pair two column-arrays side by side with a fixed gap. */
function joinColumns(left: string[], right: string[], gap = 4): string[] {
  const n = Math.max(left.length, right.length);
  const leftWidth = Math.max(0, ...left.map(visibleWidth));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    const pad = " ".repeat(Math.max(0, leftWidth - visibleWidth(l)));
    out.push(`${l}${pad}${" ".repeat(gap)}${r}`);
  }
  return out;
}

/** One panel-style horizontal rule using a skin border color. */
function rule(ch = "─"): string {
  const w = Math.min(termWidth(), 100);
  return color(ch.repeat(w), fg(roleColor("border", "#3A4B5C")));
}

/**
 * Print the welcome banner. `info` omits pieces we don't know yet — the REPL
 * calls this before it has a session id, then re-renders the status line after.
 */
export function printWelcomeBanner(info: BannerInfo): void {
  const skin = getActiveSkin();
  const accent = fg(roleColor("accent", "#FFB84D"));
  const muted = fg(roleColor("muted", "#8A8A8A"));
  const text = fg(roleColor("text", "#E8E8E8"));
  const ok = fg(roleColor("ok", "#7FD184"));
  const err = fg(roleColor("err", "#FF7B7B"));

  process.stdout.write("\n");

  const narrow = termWidth() < 80;
  if (narrow) {
    process.stdout.write(`${C.BOLD}${fg(roleColor("brand"))}${SQUAD_COMPACT}${C.RESET}\n\n`);
  } else {
    const logo = renderLogo();
    const hero = renderHero();
    // Right-side info block, skinned.
    const rightLines: string[] = [];
    rightLines.push(`${C.BOLD}${accent}${brandString("agent_name", "Squad")}${C.RESET}  ${muted}v${info.version}${C.RESET}`);
    rightLines.push(`${muted}gateway${C.RESET} ${text}${info.gatewayUrl}${C.RESET}`);
    rightLines.push(
      `${muted}auth   ${C.RESET} ${info.tokenSet ? `${ok}token set${C.RESET}` : `${err}no token${C.RESET}`}`,
    );
    if (info.sessionId) {
      rightLines.push(`${muted}session${C.RESET} ${text}${info.sessionId}${C.RESET}`);
    }
    if (info.cwd) {
      rightLines.push(`${muted}cwd    ${C.RESET} ${text}${info.cwd}${C.RESET}`);
    }
    rightLines.push("");
    rightLines.push(`${muted}skin   ${C.RESET} ${text}${skin.name}${C.RESET}  ${muted}· /help for commands${C.RESET}`);

    // Layout: logo (top) above hero+info side-by-side.
    for (const line of logo) process.stdout.write(line + "\n");
    process.stdout.write("\n");
    const rows = joinColumns(hero, rightLines, 4);
    for (const row of rows) process.stdout.write("  " + row + "\n");
    process.stdout.write("\n");
  }

  if (info.tip) {
    const label = color("tip", fg(roleColor("accent")), C.BOLD);
    process.stdout.write(`${label} ${muted}${info.tip}${C.RESET}\n\n`);
  }
}

/** A slimmer banner used when the user runs `squad --help` etc. */
export function printCompactHeader(): void {
  const brand = fg(roleColor("brand", "#5EE1FF"));
  process.stdout.write(`${C.BOLD}${brand}squad${C.RESET} ${color("v" + pkgVersion(), fg(roleColor("muted")))}\n`);
}

export function currentVersion(): string {
  return pkgVersion();
}

// Expose for tests / debug:
export const _internals = { SQUAD_LOGO, SQUAD_COMPACT, SQUAD_HERO, joinColumns, stripAnsi };
