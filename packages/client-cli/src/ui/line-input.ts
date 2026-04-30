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
  /** First visible menu index — shifts so the selection stays on screen. */
  private menuOffset = 0;
  private extraLines = 0; // menu rows currently drawn below the input line
  private running = false;
  private paused = false;

  /**
   * Picker mode state. Non-null while {@link pick} is awaiting a selection.
   * In picker mode the buffer is a filter, the menu shows the caller's items,
   * Enter returns the selection, Esc returns null.
   */
  private pickerState: {
    label: string;
    items: MenuItem[];
    restore: {
      buffer: string;
      cursor: number;
      menuSelected: number;
      menuOffset: number;
      menuOpen: boolean;
      menuItems: MenuItem[];
    };
  } | null = null;
  private pickerResolver: ((choice: MenuItem | null) => void) | null = null;

  /**
   * Reverse-i-search mode (`Ctrl+R`). The displayed line shows the latest
   * matching history entry; further characters tighten the search. Enter
   * accepts and submits the matched line; Esc cancels back to the prior
   * buffer; Ctrl+R re-fires to find the next older match.
   */
  private rsearchState: {
    pattern: string;
    matchIdx: number | null;
    /** Saved buffer + cursor to restore on cancel. */
    savedBuffer: string;
    savedCursor: number;
  } | null = null;

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

  /**
   * Prompt the user to pick one item from a list. Takes over the input line
   * with a filter prompt + scrolling list until the user presses Enter (→
   * returns the selection) or Esc / Ctrl+C (→ resolves null). Type to filter;
   * arrow keys + Tab/Enter cycle and accept just like the slash menu.
   */
  pick(opts: {
    label: string;
    items: MenuItem[];
    initialFilter?: string;
  }): Promise<MenuItem | null> {
    return new Promise((resolve) => {
      if (!this.running) this.start();
      // If the caller paused us (e.g. a slash handler is running with input
      // suspended), we need to come back online to accept picker keystrokes.
      const wasPaused = this.paused;
      this.paused = false;
      // Stash the normal-mode state so we can restore it on exit.
      this.pickerState = {
        label: opts.label,
        items: opts.items,
        restore: {
          buffer: this.buffer,
          cursor: this.cursor,
          menuSelected: this.menuSelected,
          menuOffset: this.menuOffset,
          menuOpen: this.menuOpen,
          menuItems: this.menuItems,
        },
      };
      // Remember the caller's paused state so the picker restores it on exit.
      this.pickerResolver = (choice) => {
        this.paused = wasPaused;
        resolve(choice);
      };
      this.buffer = opts.initialFilter ?? "";
      this.cursor = this.buffer.length;
      this.menuSelected = 0;
      this.menuOffset = 0;
      this.recomputePickerItems();
      this.render();
    });
  }

  private pickerResolve(choice: MenuItem | null): void {
    if (!this.pickerState || !this.pickerResolver) return;
    const resolver = this.pickerResolver;
    const { restore } = this.pickerState;
    // Tear down the picker render before restoring state. We don't redraw
    // the normal input here — the resolver hands control back to the caller,
    // which will write its own output (e.g. "resumed session…") and then
    // call input.resume() via prePrompt, which handles redraw.
    this.clearRender();
    this.pickerState = null;
    this.pickerResolver = null;
    this.buffer = restore.buffer;
    this.cursor = restore.cursor;
    this.menuSelected = restore.menuSelected;
    this.menuOffset = restore.menuOffset;
    this.menuOpen = restore.menuOpen;
    this.menuItems = restore.menuItems;
    resolver(choice);
  }

  /**
   * Visible menu items — in slash mode this is the full menu list; in picker
   * mode it's the filtered view. Used so Enter/Up/Down always operate on the
   * same array the renderer drew.
   */
  private visibleMenuItems(): MenuItem[] {
    return this.menuItems;
  }

  private recomputePickerItems(): void {
    if (!this.pickerState) return;
    const q = this.buffer.toLowerCase().trim();
    if (!q) {
      this.menuItems = this.pickerState.items.slice();
    } else {
      this.menuItems = this.pickerState.items.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          (it.summary ?? "").toLowerCase().includes(q) ||
          (it.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
      );
    }
    this.menuOpen = this.menuItems.length > 0;
    if (this.menuSelected >= this.menuItems.length) this.menuSelected = 0;
    this.ensureSelectionVisible();
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
    if (!this.running) return;
    const k = key ?? {};

    // Ctrl+C must work even when we're paused (agent is thinking, a slash
    // handler is awaiting, etc). Tiered interrupt is the REPL's job; we just
    // surface the signal so it can run its double-press-to-exit logic.
    if (k.ctrl && k.name === "c") {
      if (this.pickerState) {
        this.pickerResolve(null);
        return;
      }
      this.emit("interrupt");
      return;
    }

    // Everything else is suppressed while paused — the agent is working,
    // tool output is streaming, etc.
    if (this.paused) return;
    // Ctrl+D on empty buffer → exit.
    if (k.ctrl && k.name === "d") {
      if (this.buffer.length === 0) {
        this.emit("exit");
      }
      return;
    }
    if (k.name === "return" || k.name === "enter") {
      // Picker mode: Enter commits the current selection and exits.
      if (this.pickerState) {
        this.pickerResolve(this.visibleMenuItems()[this.menuSelected] ?? null);
        return;
      }
      // Multi-line: a buffer ending in a single trailing `\` is taken as
      // "soft newline — keep typing". Replace the `\` with a real newline
      // and don't submit. Alt+Enter (key.meta) does the same without the
      // backslash, for users with a terminal that sends meta on option.
      if (k.meta) {
        this.buffer =
          this.buffer.slice(0, this.cursor) + "\n" + this.buffer.slice(this.cursor);
        this.cursor += 1;
        this.refreshMenu();
        this.render();
        return;
      }
      if (
        this.buffer.length > 0 &&
        this.buffer.endsWith("\\") &&
        !this.buffer.endsWith("\\\\")
      ) {
        this.buffer = this.buffer.slice(0, -1) + "\n";
        this.cursor = this.buffer.length;
        this.refreshMenu();
        this.render();
        return;
      }
      // Slash mode with the menu open: if the buffer already matches an
      // item exactly (user fully typed `/help`), submit as-is. Otherwise
      // accept the highlighted selection first (arrow-key picked or partial
      // match), then submit it — the user still gets one-press submit.
      if (this.menuOpen && this.menuItems.length > 0) {
        const exact = this.menuItems.find((it) => this.buffer === "/" + it.name);
        if (!exact) {
          const sel = this.menuItems[this.menuSelected];
          if (sel) {
            this.buffer = "/" + sel.name;
            this.cursor = this.buffer.length;
          }
        }
      }
      this.submit();
      return;
    }

    if (k.name === "tab") {
      if (this.pickerState) {
        this.pickerResolve(this.visibleMenuItems()[this.menuSelected] ?? null);
        return;
      }
      if (this.menuOpen) this.acceptMenu();
      return;
    }

    if (k.name === "escape") {
      if (this.pickerState) {
        this.pickerResolve(null);
        return;
      }
      if (this.rsearchState) {
        // Cancel: restore the buffer the user had before Ctrl+R.
        this.buffer = this.rsearchState.savedBuffer;
        this.cursor = this.rsearchState.savedCursor;
        this.rsearchState = null;
        this.refreshMenu();
        this.render();
        return;
      }
      if (this.menuOpen) {
        this.menuOpen = false;
        this.render();
      }
      return;
    }

    // Ctrl+R: enter / advance reverse-i-search.
    if (k.ctrl && k.name === "r") {
      if (!this.rsearchState) {
        this.rsearchState = {
          pattern: "",
          matchIdx: null,
          savedBuffer: this.buffer,
          savedCursor: this.cursor,
        };
        this.menuOpen = false;
        this.menuItems = [];
        this.render();
        return;
      }
      // Already in r-search: find the next older match for the same pattern.
      this.advanceReverseSearch();
      this.render();
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
      if (this.rsearchState) {
        this.rsearchState.pattern = this.rsearchState.pattern.slice(0, -1);
        this.rsearchState.matchIdx = null;
        this.findReverseSearch();
        this.render();
        return;
      }
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
      if (this.rsearchState) {
        this.rsearchState.pattern += str;
        this.rsearchState.matchIdx = null;
        this.findReverseSearch();
        this.render();
        return;
      }
      this.buffer = this.buffer.slice(0, this.cursor) + str + this.buffer.slice(this.cursor);
      this.cursor += str.length;
      this.refreshMenu();
      this.render();
    }
  };

  /** Search history (newest first) for the latest match of the pattern. */
  private findReverseSearch(): void {
    if (!this.rsearchState) return;
    const pat = this.rsearchState.pattern.toLowerCase();
    if (!pat) {
      this.buffer = "";
      this.cursor = 0;
      this.rsearchState.matchIdx = null;
      return;
    }
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i] ?? "";
      if (entry.toLowerCase().includes(pat)) {
        this.buffer = entry;
        this.cursor = entry.length;
        this.rsearchState.matchIdx = i;
        return;
      }
    }
    // No match — leave the buffer empty so the user sees the failure clearly.
    this.buffer = "";
    this.cursor = 0;
    this.rsearchState.matchIdx = null;
  }

  /** Find the next older match (called on Ctrl+R while already searching). */
  private advanceReverseSearch(): void {
    if (!this.rsearchState) return;
    const pat = this.rsearchState.pattern.toLowerCase();
    if (!pat) return;
    const start =
      this.rsearchState.matchIdx !== null ? this.rsearchState.matchIdx - 1 : this.history.length - 1;
    for (let i = start; i >= 0; i--) {
      const entry = this.history[i] ?? "";
      if (entry.toLowerCase().includes(pat)) {
        this.buffer = entry;
        this.cursor = entry.length;
        this.rsearchState.matchIdx = i;
        return;
      }
    }
    // Wrap around to the bottom for the next press.
    this.rsearchState.matchIdx = null;
  }

  // ── menu + history ─────────────────────────────────────────────────────

  private refreshMenu(): void {
    if (this.pickerState) {
      this.recomputePickerItems();
      return;
    }
    // Menu opens only while typing the command token itself — once the user
    // types a space (moving into args), the menu collapses so it doesn't
    // cover the args area while they're still typing.
    if (this.buffer.startsWith("/") && !/\s/.test(this.buffer)) {
      const items = this.opts.menuProvider(this.buffer);
      this.menuItems = items;
      this.menuOpen = items.length > 0;
      if (this.menuSelected >= items.length) this.menuSelected = 0;
      this.ensureSelectionVisible();
    } else {
      this.menuOpen = false;
      this.menuItems = [];
      this.menuSelected = 0;
      this.menuOffset = 0;
    }
  }

  /** Number of menu rows we can show in the visible area (leaves slack). */
  private menuVisibleLimit(): number {
    const rows = (stdout.rows ?? 24) - 4;
    return Math.max(3, Math.min(10, rows));
  }

  /**
   * Shift {@link menuOffset} so the selected index is on screen. Called after
   * any selection change so arrow keys keep scrolling past the visible
   * window rather than overshooting off-screen.
   */
  private ensureSelectionVisible(): void {
    const limit = this.menuVisibleLimit();
    if (this.menuSelected < this.menuOffset) {
      this.menuOffset = this.menuSelected;
    } else if (this.menuSelected >= this.menuOffset + limit) {
      this.menuOffset = this.menuSelected - limit + 1;
    }
    this.menuOffset = Math.max(
      0,
      Math.min(this.menuOffset, Math.max(0, this.menuItems.length - limit)),
    );
  }

  private moveSelection(delta: number): void {
    if (!this.menuOpen || this.menuItems.length === 0) return;
    const n = this.menuItems.length;
    this.menuSelected = (this.menuSelected + delta + n) % n;
    this.ensureSelectionVisible();
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
    // Exit reverse-i-search mode if we're submitting from inside it.
    this.rsearchState = null;
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
    this.menuOffset = 0;
    this.emit("line", line);
  }

  // ── rendering ──────────────────────────────────────────────────────────

  private termCols(): number {
    return stdout.columns ?? 80;
  }

  private pickerPrompt(label: string): string {
    const accent = fg(roleColor("accent"));
    const muted = fg(roleColor("muted"));
    return (
      color(`? ${label} `, accent, C.BOLD) +
      color("(type to filter · ↑↓ cycle · enter pick · esc cancel) ", muted)
    );
  }

  private rsearchPrompt(): string {
    const accent = fg(roleColor("accent"));
    const muted = fg(roleColor("muted"));
    const pat = this.rsearchState?.pattern ?? "";
    const noMatch = this.rsearchState?.matchIdx === null && pat.length > 0;
    const tag = noMatch ? "(failed reverse-i-search)" : "(reverse-i-search)";
    return color(`${tag} \`${pat}': `, noMatch ? muted : accent, C.BOLD);
  }

  private renderMenuRow(item: MenuItem, selected: boolean): string {
    const accent = fg(roleColor("accent"));
    const brand = fg(roleColor("brand"));
    const muted = fg(roleColor("muted"));
    const text = fg(roleColor("text"));

    // Truncate summary on plain text *before* wrapping it in color codes, so
    // long rows keep their ANSI styling (earlier versions stripped ANSI
    // during truncation, leaving wide rows rendered as bare white text).
    const leftPlain = `  /${item.name}`; // marker width (1) + space + slash + name
    const leftVisibleWidth = leftPlain.length;
    const leftColWidth = Math.max(leftVisibleWidth, 20);
    const gapWidth = 2;
    const summaryRoom = Math.max(10, this.termCols() - leftColWidth - gapWidth - 1);
    const summary = item.summary.length > summaryRoom
      ? item.summary.slice(0, summaryRoom - 1) + "…"
      : item.summary;

    const marker = selected ? color("▸", accent, C.BOLD) : " ";
    const name = color(`/${item.name}`, brand, C.BOLD);
    const desc = selected
      ? color(summary, text, C.BOLD)
      : color(summary, muted);

    const leftPad = leftColWidth - leftVisibleWidth;
    return `${marker} ${name}${" ".repeat(leftPad)}${" ".repeat(gapWidth)}${desc}`;
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

    const prompt = this.pickerState
      ? this.pickerPrompt(this.pickerState.label)
      : this.rsearchState
        ? this.rsearchPrompt()
        : this.opts.prompt();
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
    // Multi-line buffer: collapse internal newlines into a visible glyph
    // so the input stays on one row. The newlines are preserved in the
    // submitted line; users see ↵ where they pressed Alt+Enter / typed `\`.
    const muted = fg(roleColor("muted"));
    const visualDisplay = display.replace(/\n/g, color("↵", muted));
    stdout.write(prompt + visualDisplay);

    let extra = 0;
    if (this.menuOpen && this.menuItems.length > 0) {
      const muted = fg(roleColor("muted"));
      const limit = this.menuVisibleLimit();
      const start = this.menuOffset;
      const end = Math.min(start + limit, this.menuItems.length);
      const above = start;
      const below = this.menuItems.length - end;

      if (above > 0) {
        stdout.write("\n");
        stdout.write(color(`  ↑ ${above} more`, muted));
        extra++;
      }
      for (let i = start; i < end; i++) {
        const item = this.menuItems[i]!;
        stdout.write("\n");
        stdout.write(this.renderMenuRow(item, i === this.menuSelected));
        extra++;
      }
      if (below > 0) {
        stdout.write("\n");
        stdout.write(color(`  ↓ ${below} more`, muted));
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
