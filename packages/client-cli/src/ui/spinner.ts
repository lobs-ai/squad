/**
 * Inline spinner for the REPL. Lives on a single line; redraws in place using
 * a carriage return + clear-to-end-of-line. Safe to no-op when stdout isn't a
 * TTY or color is disabled.
 *
 * Usage:
 *   const sp = new Spinner("thinking");
 *   sp.start();                 // begins animating
 *   sp.setLabel("calling tool: read_file");
 *   sp.stop();                  // clears the line
 */

import { C, color, fg, shouldUseColor } from "./colors.js";
import { roleColor } from "./skin.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label: string;
  private startedAt = 0;
  private active = false;

  constructor(label = "working") {
    this.label = label;
  }

  /** Begin animating. Idempotent. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    if (!shouldUseColor() || !process.stdout.isTTY) {
      // No animation, but still mark active so callers can stop cleanly.
      process.stdout.write(`  ${this.label}…\n`);
      return;
    }
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
  }

  /** Update the label live — used when a tool call starts. */
  setLabel(label: string): void {
    this.label = label;
    if (this.active && shouldUseColor() && process.stdout.isTTY) this.render();
  }

  /** Stop animating and clear the spinner line. Safe to call if not started. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!shouldUseColor() || !process.stdout.isTTY) return;
    // Erase the spinner line and restore cursor.
    process.stdout.write("\r\x1b[2K\x1b[?25h");
  }

  /** Elapsed time since .start(), formatted for display. */
  elapsed(): string {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${s % 60}s`;
  }

  private render(): void {
    const glyph = color(FRAMES[this.frame]!, fg(roleColor("accent")), C.BOLD);
    const muted = fg(roleColor("muted"));
    const elapsed = color(`(${this.elapsed()})`, muted);
    const label = color(this.label, fg(roleColor("text")));
    // Clear line, write spinner, no newline — next render overwrites.
    process.stdout.write(`\r\x1b[2K${glyph} ${label} ${elapsed}`);
  }
}
