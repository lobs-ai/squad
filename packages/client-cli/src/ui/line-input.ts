/**
 * LineInput — a readline replacement with a live slash-command menu.
 *
 * Why we don't use Node's built-in readline: readline's completer only fires
 * on Tab and can't render a multi-line menu under the cursor. This class
 * drives stdin in raw mode, renders an inline menu for slash commands, and
 * supports arrow-key cycling, Tab-to-accept, and up/down history nav.
 *
 * The input area is a "block" of N lines (prompt + optional menu rows).
 * External code calling {@link print} routes output through the block so
 * streamed agent text and the menu never clobber each other.
 */

import { EventEmitter } from "node:events";
import { emitKeypressEvents, clearScreenDown, moveCursor, cursorTo } from "node:readline";
import { stdin, stdout } from "node:process";
import { C, color, fg, stripAnsi, visibleWidth } from "./colors.js";
import { roleColor } from "./skin.js";

export interface MenuItem {
  /** The full command name, e.g. `help`. Without leading slash. */
  name: string;
  /** One-line summary shown next to the name. */
  summary: string;
  /** Optional `<arg>` usage suffix displayed in muted text. */
  usage?: string;
  /** Aliases shown with a `·` separator (muted). */
  aliases?: string[];
}

export interface MenuProvider {
  /**
   * Called on every input change when the buffer starts with `/` and no
   * whitespace has been typed yet. Return the filtered items to show; return
   * an empty array to hide the menu.
   */
  (bufferWithSlash: string): MenuItem[];
}

export interface LineInputOptions {
  /** Prompt string renderer. Called fresh on every repaint. */
  prompt(): string;
  /** Filter function for the slash-command menu. */
  menuProvider: MenuProvider;
  /** Persisted history, most-recent-last. Loaded once at start. */
  initialHistory?: string[];
  /** Called on each submitted line to persist it. */
  onHistoryAppend?: (line: string) => void;
  /** Max history entries kept in memory. */
  historyLimit?: number;
}

type Keypress = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
};

export class LineInput extends EventEmitter {
  private buffer = "";
  /** Cursor position within `buffer` (0..buffer.length). */
  private cursor = 0;
  private readonly history: string[];
  private historyIndex: number | null = null;
  private historyStash = "";
  private menuItems: MenuItem[] = [];
  private menuOpen = false;
  private menuSelected = 0;
  private extraLines = 0; // menu rows currently drawn below the input line
  private running = false;
  private paused = false;

  constructor(private readonly opts: LineInputOptions) {
    super();
    this.history = (opts.initialHistory ?? []).slice(
      -((opts.historyLimit ?? 1000) | 0),
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    if (stdin.isTTY) stdin.setRawMode(true);
    emitKeypressEvents(stdin);
    stdin.on("keypress", this.handleKeypress);
    stdin.resume();
    this.render();
  }

  isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    stdin.off("keypress", this.handleKeypress);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    this.clearRender();
  }

  /**
   * Temporarily hide the input + menu so external writers (spinner, streamed
   * assistant text, tool call lines) can write unobstructed. Pair with
   * {@link resume}.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clearRender();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.render();
  }

  /**
   * Print lines above the input area without fighting its cursor. Any output
   * that happens between turns (assistant messages, tool call lines, errors)
   * should go through here so the input area stays clean.
   */
  print(text: string): void {
    this.clearRender();
    stdout.write(text);
    if (!this.paused && this.running) this.render();
  }

  /** Replace the buffer content (used when accepting a menu entry). */
  setBuffer(s: string): void {
    this.buffer = s;
    this.cursor = s.length;
    this.refreshMenu();
    this.render();
  }

  // ── input handling ─────────────────────────────────────────────────────

  private handleKeypress = (str: string | undefined, key?: Keypress): void => {
    if (!this.running || this.paused) return;
    const k = key ?? {};

    // Ctrl+C → emit interrupt (owner decides whether to exit on double-press).
    if (k.ctrl && k.name === "c") {
      this.emit("interrupt");
      return;
    }
    // Ctrl+D on empty buffer → exit.
    if (k.ctrl && k.name === "d") {
      if (this.buffer.length === 0) {
        this.emit("exit");
      }
      return;
    }
    // Enter submits — accept the menu selection first if it's open.
    if (k.name === "return" || k.name === "enter") {
      if (this.menuOpen) {
        this.acceptMenu();
        return;
      }
      this.submit();
      return;
    }

    if (k.name === "tab") {
      if (this.menuOpen) this.acceptMenu();
      return;
    }

    if (k.name === "escape") {
      if (this.menuOpen) {
        this.menuOpen = false;
        this.render();
      }
      return;
    }

    if (k.name === "up") {
      if (this.menuOpen) this.moveSelection(-1);
      else this.historyPrev();
      this.render();
      return;
    }
    if (k.name === "down") {
      if (this.menuOpen) this.moveSelection(1);
      else this.historyNext();
      this.render();
      return;
    }

    if (k.name === "left") {
      this.cursor = Math.max(0, this.cursor - 1);
      this.render();
      return;
    }
    if (k.name === "right") {
      this.cursor = Math.min(this.buffer.length, this.cursor + 1);
      this.render();
      return;
    }
    if (k.name === "home" || (k.ctrl && k.name === "a")) {
      this.cursor = 0;
      this.render();
      return;
    }
    if (k.name === "end" || (k.ctrl && k.name === "e")) {
      this.cursor = this.buffer.length;
      this.render();
      return;
    }

    if (k.name === "backspace") {
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
        this.refreshMenu();
        this.render();
      }
      return;
    }
    if (k.name === "delete") {
      if (this.cursor < this.buffer.length) {
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        this.refreshMenu();
        this.render();
      }
      return;
    }
    if (k.ctrl && k.name === "u") {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
      this.refreshMenu();
      this.render();
      return;
    }
    if (k.ctrl && k.name === "k") {
      this.buffer = this.buffer.slice(0, this.cursor);
      this.refreshMenu();
      this.render();
      return;
    }
    if (k.ctrl && k.name === "w") {
      // Word-delete behind cursor.
      const head = this.buffer.slice(0, this.cursor);
      const tail = this.buffer.slice(this.cursor);
      const trimmed = head.replace(/[^\s]*\s*$/, "");
      this.buffer = trimmed + tail;
      this.cursor = trimmed.length;
      this.refreshMenu();
      this.render();
      return;
    }
    if (k.ctrl && k.name === "l") {
      stdout.write("\x1b[2J\x1b[H");
      this.render();
      return;
    }

    // Printable input.
    if (str && !k.ctrl && !k.meta && str.length >= 1 && str.charCodeAt(0) >= 32) {
      this.buffer = this.buffer.slice(0, this.cursor) + str + this.buffer.slice(this.cursor);
      this.cursor += str.length;
      this.refreshMenu();
      this.render();
    }
  };

  // ── menu + history ─────────────────────────────────────────────────────

  private refreshMenu(): void {
    // Menu opens only while typing the command token itself — once the user
    // types a space (moving into args), the menu collapses so it doesn't
    // cover the args area while they're still typing.
    if (this.buffer.startsWith("/") && !/\s/.test(this.buffer)) {
      const items = this.opts.menuProvider(this.buffer);
      this.menuItems = items;
      this.menuOpen = items.length > 0;
      if (this.menuSelected >= items.length) this.menuSelected = 0;
    } else {
      this.menuOpen = false;
      this.menuItems = [];
      this.menuSelected = 0;
    }
  }

  private moveSelection(delta: number): void {
    if (!this.menuOpen || this.menuItems.length === 0) return;
    const n = this.menuItems.length;
    this.menuSelected = (this.menuSelected + delta + n) % n;
  }

  private acceptMenu(): void {
    if (!this.menuOpen) return;
    const item = this.menuItems[this.menuSelected];
    if (!item) return;
    // Complete to `/name ` so the user can immediately start typing args.
    this.buffer = "/" + item.name + " ";
    this.cursor = this.buffer.length;
    this.menuOpen = false;
    this.render();
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      this.historyStash = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.buffer = this.history[this.historyIndex] ?? "";
    this.cursor = this.buffer.length;
    this.refreshMenu();
  }

  private historyNext(): void {
    if (this.historyIndex === null) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.buffer = this.history[this.historyIndex] ?? "";
    } else {
      this.historyIndex = null;
      this.buffer = this.historyStash;
      this.historyStash = "";
    }
    this.cursor = this.buffer.length;
    this.refreshMenu();
  }

  private submit(): void {
    const line = this.buffer;
    // Finalize the current render — commit the line as a permanent row.
    this.clearRender();
    const prompt = this.opts.prompt();
    stdout.write(prompt + line + "\n");
    if (line.trim().length > 0) {
      this.history.push(line);
      const limit = this.opts.historyLimit ?? 1000;
      if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
      this.opts.onHistoryAppend?.(line);
    }
    this.buffer = "";
    this.cursor = 0;
    this.historyIndex = null;
    this.historyStash = "";
    this.menuOpen = false;
    this.menuItems = [];
    this.menuSelected = 0;
    this.emit("line", line);
  }

  // ── rendering ──────────────────────────────────────────────────────────

  private termCols(): number {
    return stdout.columns ?? 80;
  }

  private renderMenuRow(item: MenuItem, selected: boolean): string {
    const muted = fg(roleColor("muted"));
    const accent = fg(roleColor("accent"));
    const brand = fg(roleColor("brand"));
    const text = fg(roleColor("text"));

    const marker = selected ? color("▸", accent, C.BOLD) : " ";
    const name = color(`/${item.name}`, brand, C.BOLD);
    const usage = item.usage ? color(` ${item.usage}`, muted) : "";
    const aliasPart =
      item.aliases && item.aliases.length > 0
        ? color(` · ${item.aliases.map((a) => "/" + a).join(" ")}`, muted)
        : "";
    const desc = color(item.summary, selected ? text : muted);

    // Width-aware padding: pad the left part (marker + name + usage + aliases)
    // to a consistent column so descriptions line up.
    const left = `${marker} ${name}${usage}${aliasPart}`;
    const leftPad = Math.max(0, 28 - visibleWidth(left));
    const row = `${left}${" ".repeat(leftPad)}  ${desc}`;

    const trimmed = visibleWidth(row) > this.termCols()
      ? truncateVisible(row, this.termCols() - 1)
      : row;
    if (selected) {
      // Soft accent background for the selected row so arrow-key movement is obvious.
      return color(trimmed, C.REVERSE);
    }
    return trimmed;
  }

  /**
   * Redraw the input area. Assumes the cursor is at the start of the input
   * row — {@link clearRender} ensures that. Writes input line, optional menu,
   * then repositions the cursor back onto the input row at the right column.
   */
  private render(): void {
    if (!this.running || this.paused) return;
    // Clear any previous render footprint first.
    this.clearRender();

    const prompt = this.opts.prompt();
    const promptWidth = visibleWidth(prompt);
    // Truncate displayed buffer if it's wider than the terminal minus prompt,
    // so we never wrap (keeps cursor math trivial).
    const cols = this.termCols();
    const room = Math.max(1, cols - promptWidth);
    let display = this.buffer;
    let cursorDisplay = this.cursor;
    if (display.length > room) {
      // Keep a window around the cursor.
      const start = Math.max(0, this.cursor - Math.floor(room * 0.8));
      display = display.slice(start, start + room);
      cursorDisplay = this.cursor - start;
    }

    stdout.write("\r");
    stdout.write(prompt + display);

    let extra = 0;
    if (this.menuOpen && this.menuItems.length > 0) {
      const max = Math.min(this.menuItems.length, 8);
      for (let i = 0; i < max; i++) {
        const item = this.menuItems[i]!;
        stdout.write("\n");
        stdout.write(this.renderMenuRow(item, i === this.menuSelected));
        extra++;
      }
      if (this.menuItems.length > max) {
        stdout.write("\n");
        stdout.write(color(`  … ${this.menuItems.length - max} more`, fg(roleColor("muted"))));
        extra++;
      }
      // Move cursor back up to the input row.
      moveCursor(stdout, 0, -extra);
    }
    // Reposition cursor to after the prompt, offset by cursorDisplay.
    cursorTo(stdout, promptWidth + cursorDisplay);
    this.extraLines = extra;
  }

  private clearRender(): void {
    if (!this.running) return;
    // We're assumed to be on the input row. Clear it and everything below,
    // then come back to col 0 of the input row.
    stdout.write("\r");
    clearScreenDown(stdout);
    this.extraLines = 0;
  }
}

function truncateVisible(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  // Strip ANSI, truncate, then re-inject a reset — good enough for menu rows.
  const plain = stripAnsi(s);
  const cut = plain.slice(0, Math.max(0, max - 1)) + "…";
  return cut;
}
