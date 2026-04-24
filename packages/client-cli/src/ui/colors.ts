/**
 * ANSI color primitives. Mirrors hermes_cli/colors.py.
 *
 * Honors `NO_COLOR` (https://no-color.org/) and `TERM=dumb`, and falls back
 * to no-color on non-TTY stdout so piped output stays readable.
 */

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  // FORCE_COLOR respected like other CLIs (chalk, ink) so `squad | less -R`
  // and similar pipelines stay colored when the user opts in.
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if (!process.stdout.isTTY) return false;
  return true;
}

/** Return the given ANSI escape string, or "" when color is disabled. */
function gated(code: string): string {
  return shouldUseColor() ? code : "";
}

const RAW = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  UNDERLINE: "\x1b[4m",
  REVERSE: "\x1b[7m",
  BLACK: "\x1b[30m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
  BRIGHT_BLACK: "\x1b[90m",
  BRIGHT_RED: "\x1b[91m",
  BRIGHT_GREEN: "\x1b[92m",
  BRIGHT_YELLOW: "\x1b[93m",
  BRIGHT_BLUE: "\x1b[94m",
  BRIGHT_MAGENTA: "\x1b[95m",
  BRIGHT_CYAN: "\x1b[96m",
  BRIGHT_WHITE: "\x1b[97m",
} as const;

/**
 * ANSI escape constants, gated by `shouldUseColor()`. Property access returns
 * `""` when color is disabled (NO_COLOR, piped output) so template literals
 * stay clean without a separate branch.
 */
export const C: { readonly [K in keyof typeof RAW]: string } = new Proxy(RAW, {
  get(target, prop) {
    if (!shouldUseColor()) return "";
    return (target as Record<string, string>)[prop as string] ?? "";
  },
}) as { readonly [K in keyof typeof RAW]: string };

/** Wrap text with one or more ANSI codes. No-op when color is disabled. */
export function color(text: string, ...codes: string[]): string {
  if (!shouldUseColor()) return text;
  return codes.join("") + text + RAW.RESET;
}

/**
 * Render a truecolor (24-bit) foreground hex like `#FFD700` as an ANSI escape.
 * Returns an empty string when color is disabled.
 */
export function fg(hex: string): string {
  if (!shouldUseColor()) return "";
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return "";
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bg(hex: string): string {
  if (!shouldUseColor()) return "";
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return "";
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Strip ANSI sequences for width math and piped/no-color fallbacks. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width (simple): ANSI-stripped character count. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}
