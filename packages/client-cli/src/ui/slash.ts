/**
 * Slash command registry for the REPL.
 *
 * Commands are declared declaratively — `name`, `aliases`, `summary`,
 * `usage`, and a `run(ctx, args)` handler. The dispatcher supports prefix
 * matching (/h → /help) when unambiguous, and prints a helpful suggestion
 * when unknown.
 */

import type { ProtocolClient } from "../protocol-client.js";
import * as render from "./render.js";
import type { VerboseLevel } from "./render.js";
import { C, color, fg } from "./colors.js";
import { roleColor, setActiveSkin, listSkins, getActiveSkin } from "./skin.js";
import { renderStatusbar, setStatusbarEnabled, isStatusbarEnabled } from "./statusbar.js";
import type { LineInput } from "./line-input.js";
import type { Task, QuestionRecord } from "@squad/protocol";

export interface SlashContext {
  client: ProtocolClient;
  /** The live input instance, so handlers can drive pickers (/resume etc.). */
  input: LineInput;
  /** Current session id. Mutable — /new and /resume replace it. */
  state: {
    sessionId: string;
    verbose: VerboseLevel;
    shouldExit: boolean;
    pendingQuestion: QuestionRecord | null;
    /** Called by REPL to re-subscribe when the session id changes. */
    onSessionChange: (newId: string) => Promise<void>;
  };
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  run(ctx: SlashContext, args: string[]): Promise<void>;
}

const COMMANDS: SlashCommand[] = [];

function reg(cmd: SlashCommand): void {
  COMMANDS.push(cmd);
}

// ── help ────────────────────────────────────────────────────────────────────

reg({
  name: "help",
  aliases: ["?"],
  summary: "show all slash commands",
  async run() {
    render.renderHeader("Commands");
    const muted = fg(roleColor("muted"));
    const accent = fg(roleColor("accent"));
    for (const cmd of COMMANDS) {
      const aliasStr = cmd.aliases?.length ? color(` · ${cmd.aliases.map((a) => "/" + a).join(" ")}`, muted) : "";
      const usage = cmd.usage ? color(` ${cmd.usage}`, muted) : "";
      process.stdout.write(
        `  ${accent}/${cmd.name}${C.RESET}${usage}${aliasStr}\n    ${muted}${cmd.summary}${C.RESET}\n`,
      );
    }
    process.stdout.write("\n");
  },
});

// ── exit ────────────────────────────────────────────────────────────────────

reg({
  name: "exit",
  aliases: ["quit", "q"],
  summary: "leave the REPL",
  async run(ctx) {
    ctx.state.shouldExit = true;
  },
});

// ── clear ───────────────────────────────────────────────────────────────────

reg({
  name: "clear",
  aliases: ["cls"],
  summary: "clear the terminal",
  async run() {
    process.stdout.write("\x1b[2J\x1b[H");
  },
});

// ── tasks ───────────────────────────────────────────────────────────────────

reg({
  name: "tasks",
  summary: "list tasks in the current session",
  async run(ctx) {
    const { tasks } = await ctx.client.request("tasks.list", {
      sessionId: ctx.state.sessionId,
      includeDeleted: false,
    });
    render.renderTaskList(tasks as Task[]);
  },
});

// ── questions ───────────────────────────────────────────────────────────────

reg({
  name: "questions",
  aliases: ["ask"],
  summary: "list open ask-user questions",
  async run(ctx) {
    const { questions } = await ctx.client.request("questions.list", {
      sessionId: ctx.state.sessionId,
    });
    if (questions.length === 0) {
      render.renderInfo("(no open questions)");
      return;
    }
    for (const q of questions as QuestionRecord[]) {
      process.stdout.write(render.renderAskPrompt(q));
    }
  },
});

// ── sessions list / new / resume ────────────────────────────────────────────

reg({
  name: "sessions",
  aliases: ["ls"],
  summary: "pick a session to resume (cycle with ↑/↓, type to search)",
  usage: "[--list] [--all]",
  async run(ctx, args) {
    const listOnly = args.includes("--list");
    const all = args.includes("--all");
    const limit = all ? 200 : 50;
    const { sessions } = await ctx.client.request("session.list", { limit });

    if (listOnly) {
      render.renderHeader(`Sessions (${sessions.length})`);
      const muted = fg(roleColor("muted"));
      const text = fg(roleColor("text"));
      const brand = fg(roleColor("brand"));
      for (const s of sessions) {
        const current = s.id === ctx.state.sessionId ? color(" ← current", fg(roleColor("accent"))) : "";
        const title = s.title ?? color("(untitled)", muted);
        process.stdout.write(
          `  ${brand}${s.id.slice(0, 8)}${C.RESET}  ${muted}${s.status.padEnd(7)}${C.RESET}  ${text}${title}${C.RESET}${current}\n`,
        );
      }
      process.stdout.write("\n");
      return;
    }

    if (sessions.length === 0) {
      render.renderInfo("(no sessions yet — use /new to start one)");
      return;
    }
    // Default: picker + resume on selection (mirrors /resume).
    const items = sessions.map((s) => ({
      name: s.id.slice(0, 8),
      summary: `${s.title ?? "(untitled)"} · ${s.model} · ${relativeTime(s.createdAt)}${
        s.id === ctx.state.sessionId ? " · current" : ""
      }`,
      aliases: [s.id],
    }));
    const choice = await ctx.input.pick({ label: "pick a session to resume", items });
    if (!choice) {
      render.renderInfo("(cancelled)");
      return;
    }
    const picked =
      sessions.find((s) => s.id === choice.aliases?.[0]) ??
      sessions.find((s) => s.id.startsWith(choice.name));
    if (!picked) {
      render.renderError("picked session not found");
      return;
    }
    await activateSession(ctx, picked.id, picked.title ?? null);
  },
});

reg({
  name: "new",
  summary: "start a fresh session",
  usage: "[title]",
  async run(ctx, args) {
    const title = args.join(" ").trim() || undefined;
    const { session } = await ctx.client.request("session.start", { title });
    await ctx.state.onSessionChange(session.id);
    render.renderSuccess(`started session ${color(session.id, fg(roleColor("brand")))}`);
  },
});

reg({
  name: "resume",
  aliases: ["r"],
  summary: "pick a session to resume (cycle with ↑/↓, type to search)",
  usage: "[id|prefix]",
  async run(ctx, args) {
    const { sessions } = await ctx.client.request("session.list", { limit: 200 });

    // Direct hit when the user types `/resume <id>` — skip the picker.
    const arg = args[0];
    if (arg) {
      const match =
        sessions.find((s) => s.id === arg) ??
        sessions.find((s) => s.id.startsWith(arg));
      if (!match) {
        render.renderError(`no session matching "${arg}"`);
        return;
      }
      await activateSession(ctx, match.id, match.title ?? null);
      return;
    }

    if (sessions.length === 0) {
      render.renderInfo("(no sessions yet — use /new to start one)");
      return;
    }

    // Build menu rows. Name is the 8-char prefix (shown as the brand id);
    // summary carries the title + model + age so the picker list reads like
    // `squad sessions`.
    const items = sessions.map((s) => ({
      name: s.id.slice(0, 8),
      summary: `${s.title ?? "(untitled)"} · ${s.model} · ${relativeTime(s.createdAt)}${
        s.id === ctx.state.sessionId ? " · current" : ""
      }`,
      aliases: [s.id],
    }));

    const choice = await ctx.input.pick({ label: "resume session", items });
    if (!choice) {
      render.renderInfo("(cancelled)");
      return;
    }
    // Match back by the 8-char prefix we stored.
    const picked =
      sessions.find((s) => s.id === choice.aliases?.[0]) ??
      sessions.find((s) => s.id.startsWith(choice.name));
    if (!picked) {
      render.renderError("picked session not found");
      return;
    }
    await activateSession(ctx, picked.id, picked.title ?? null);
  },
});

/** Helper shared by /resume (both argful and picker paths). */
async function activateSession(
  ctx: SlashContext,
  sessionId: string,
  title: string | null,
): Promise<void> {
  await ctx.client.request("session.resume", { sessionId });
  await ctx.state.onSessionChange(sessionId);
  render.renderSuccess(
    `resumed ${color(sessionId, fg(roleColor("brand")))}${title ? " — " + title : ""}`,
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── status ──────────────────────────────────────────────────────────────────

reg({
  name: "status",
  summary: "gateway health + session summary",
  async run(ctx) {
    const muted = fg(roleColor("muted"));
    try {
      const health = await ctx.client.request("admin.health", {});
      render.renderKeyValue([
        ["gateway", (health as { status?: string }).status ?? "up"],
        ["session", ctx.state.sessionId],
        ["verbose", ctx.state.verbose],
        ["skin   ", getActiveSkin().name],
        ["statusbar", isStatusbarEnabled() ? "on" : "off"],
      ]);
    } catch (err) {
      render.renderError(`admin.health failed: ${err instanceof Error ? err.message : String(err)}`);
      render.renderInfo(`${muted}session: ${ctx.state.sessionId}${C.RESET}`);
    }
  },
});

// ── verbose ─────────────────────────────────────────────────────────────────

reg({
  name: "verbose",
  aliases: ["v"],
  summary: "cycle tool-call detail: compact → args → verbose",
  async run(ctx) {
    const next: VerboseLevel =
      ctx.state.verbose === "compact" ? "args" : ctx.state.verbose === "args" ? "verbose" : "compact";
    ctx.state.verbose = next;
    render.renderInfo(`verbose = ${next}`);
  },
});

// ── skin ────────────────────────────────────────────────────────────────────

reg({
  name: "skin",
  summary: "pick a visual theme (cycle with ↑/↓, type to search)",
  usage: "[name|list]",
  async run(ctx, args) {
    const arg = args[0];
    if (arg && arg !== "list") {
      try {
        const s = setActiveSkin(arg);
        render.renderSuccess(`skin = ${s.name}`);
      } catch (err) {
        render.renderError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (arg === "list") {
      const active = getActiveSkin().name;
      render.renderHeader("Skins");
      for (const s of listSkins()) {
        const marker = s.name === active ? color("●", fg(roleColor("accent"))) : " ";
        const name = color(s.name.padEnd(12), fg(roleColor("brand")), C.BOLD);
        const desc = color(s.description, fg(roleColor("muted")));
        process.stdout.write(`  ${marker} ${name} ${desc}\n`);
      }
      process.stdout.write("\n");
      return;
    }
    // Default: picker.
    const active = getActiveSkin().name;
    const items = listSkins().map((s) => ({
      name: s.name,
      summary: `${s.description}${s.name === active ? " · current" : ""}`,
    }));
    const choice = await ctx.input.pick({ label: "pick a skin", items });
    if (!choice) {
      render.renderInfo("(cancelled)");
      return;
    }
    try {
      const s = setActiveSkin(choice.name);
      render.renderSuccess(`skin = ${s.name}`);
    } catch (err) {
      render.renderError(err instanceof Error ? err.message : String(err));
    }
  },
});

// ── statusbar ───────────────────────────────────────────────────────────────

reg({
  name: "statusbar",
  aliases: ["sb"],
  summary: "toggle the bottom status bar",
  async run(ctx) {
    setStatusbarEnabled(!isStatusbarEnabled());
    render.renderInfo(`statusbar = ${isStatusbarEnabled() ? "on" : "off"}`);
    renderStatusbar({
      sessionId: ctx.state.sessionId,
      pendingQuestion: Boolean(ctx.state.pendingQuestion),
    });
  },
});

// ── stubbed commands (features pending) ─────────────────────────────────────

reg({
  name: "title",
  summary: "rename the current session",
  usage: "<new title>",
  async run(ctx, args) {
    const title = args.join(" ").trim();
    if (!title) {
      render.renderError('usage: /title "new session title"');
      return;
    }
    const { session } = await ctx.client.request("session.rename", {
      sessionId: ctx.state.sessionId,
      title,
    });
    render.renderSuccess(`renamed to ${color(session.title ?? "(untitled)", fg(roleColor("brand")), C.BOLD)}`);
  },
});

reg({
  name: "model",
  summary: "pick a model for the current session (cycle with ↑/↓, type to search)",
  usage: "[<id>|list]",
  async run(ctx, args) {
    const arg = args[0];
    // Direct switch: /model <id>
    if (arg && arg !== "list") {
      try {
        const { session } = await ctx.client.request("session.setModel", {
          sessionId: ctx.state.sessionId,
          model: arg,
        });
        render.renderSuccess(`model = ${color(session.model, fg(roleColor("brand")), C.BOLD)}`);
      } catch (err) {
        render.renderError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const res = await ctx.client.request("admin.models", {});
    const models = res.models ?? [];
    if (!models.length) {
      render.renderInfo("no models reported by gateway — check provider credentials");
      return;
    }
    const { sessions } = await ctx.client.request("session.list", { limit: 200 });
    const active = sessions.find((s) => s.id === ctx.state.sessionId)?.model;

    if (arg === "list") {
      render.renderHeader("Models");
      const muted = fg(roleColor("muted"));
      const accent = fg(roleColor("accent"));
      const text = fg(roleColor("text"));
      const brand = fg(roleColor("brand"));
      for (const m of models) {
        const marker = m.id === active ? color("●", accent) : " ";
        const ctx_ = m.contextWindow
          ? color(` · ${(m.contextWindow / 1000).toFixed(0)}K ctx`, muted)
          : "";
        const notes = m.notes ? color(` — ${m.notes}`, muted) : "";
        process.stdout.write(
          `  ${marker} ${brand}${m.id.padEnd(32)}${C.RESET} ${text}${m.displayName}${C.RESET}  ${muted}(${m.provider})${C.RESET}${ctx_}${notes}\n`,
        );
      }
      process.stdout.write("\n");
      return;
    }

    // Default: picker.
    const items = models.map((m) => ({
      name: m.id,
      summary: `${m.displayName} · ${m.provider}${
        m.contextWindow ? ` · ${(m.contextWindow / 1000).toFixed(0)}K ctx` : ""
      }${m.id === active ? " · current" : ""}${m.notes ? " · " + m.notes : ""}`,
    }));
    const choice = await ctx.input.pick({ label: "pick a model", items });
    if (!choice) {
      render.renderInfo("(cancelled)");
      return;
    }
    try {
      const { session } = await ctx.client.request("session.setModel", {
        sessionId: ctx.state.sessionId,
        model: choice.name,
      });
      render.renderSuccess(`model = ${color(session.model, fg(roleColor("brand")), C.BOLD)}`);
    } catch (err) {
      render.renderError(err instanceof Error ? err.message : String(err));
    }
  },
});

reg({
  name: "compress",
  aliases: ["compact"],
  summary: "compact history before the next run — keeps system prompt + recent turns",
  async run(ctx) {
    const res = await ctx.client.request("session.compact", {
      sessionId: ctx.state.sessionId,
    });
    render.renderSuccess(
      `armed /compact for next turn · history before: ${res.beforeMessageCount} messages · ~${res.beforeEstimatedTokens.toLocaleString()} tokens`,
    );
    render.renderInfo("(the runner trims older turns before the next LLM call; auto-compact still runs on top)");
  },
});

reg({
  name: "usage",
  aliases: ["u"],
  summary: "token usage + context fill for the current session",
  async run(ctx) {
    try {
      const stats = await ctx.client.request("session.stats", {
        sessionId: ctx.state.sessionId,
      });
      const s = stats.session;
      const muted = fg(roleColor("muted"));
      const ok = fg(roleColor("ok"));
      const warn = fg(roleColor("warn"));
      const err = fg(roleColor("err"));
      const fillColor = (pct: number): string =>
        pct < 50 ? ok : pct < 75 ? warn : err;
      const rows: Array<[string, string]> = [
        ["model       ", `${s.model}${s.fallbacks.length ? color(` + ${s.fallbacks.length} fallback(s)`, muted) : ""}`],
        ["tokens in   ", s.tokensIn.toLocaleString()],
        ["tokens out  ", s.tokensOut.toLocaleString()],
        ["estimated   ", `~${stats.estimatedTokens.toLocaleString()} tokens in history`],
        ["messages    ", String(stats.messageCount)],
        ["turns       ", String(stats.turnCount)],
        ["tool calls  ", String(stats.toolCallCount)],
      ];
      if (stats.contextWindow && stats.contextFillPct !== null) {
        const pct = stats.contextFillPct;
        rows.push([
          "context fill",
          color(`${pct.toFixed(1)}%`, fillColor(pct), C.BOLD) +
            color(` of ${(stats.contextWindow / 1000).toFixed(0)}K`, muted),
        ]);
      }
      render.renderHeader("Usage");
      render.renderKeyValue(rows);
    } catch (e) {
      render.renderError(e instanceof Error ? e.message : String(e));
    }
  },
});

// ── dispatch ────────────────────────────────────────────────────────────────

/** Return the command that uniquely matches `needle`, or null on miss/ambiguous. */
export function resolveCommand(needle: string): { cmd: SlashCommand | null; candidates: SlashCommand[] } {
  const direct = COMMANDS.find(
    (c) => c.name === needle || (c.aliases ?? []).includes(needle),
  );
  if (direct) return { cmd: direct, candidates: [direct] };

  const prefix = COMMANDS.filter(
    (c) => c.name.startsWith(needle) || (c.aliases ?? []).some((a) => a.startsWith(needle)),
  );
  if (prefix.length === 1) return { cmd: prefix[0]!, candidates: prefix };
  return { cmd: null, candidates: prefix };
}

export async function runSlash(line: string, ctx: SlashContext): Promise<void> {
  const trimmed = line.startsWith("/") ? line.slice(1) : line;
  const [head, ...rest] = trimmed.split(/\s+/);
  if (!head) {
    render.renderError("empty command");
    return;
  }
  const { cmd, candidates } = resolveCommand(head);
  if (!cmd) {
    if (candidates.length > 1) {
      render.renderError(
        `ambiguous: /${head} matches ${candidates.map((c) => "/" + c.name).join(", ")}`,
      );
    } else {
      render.renderError(`unknown command: /${head}. Try /help.`);
    }
    return;
  }
  try {
    await cmd.run(ctx, rest);
  } catch (err) {
    render.renderError(err instanceof Error ? err.message : String(err));
  }
}

/** Simple name list for auto-complete menus (namespace-less). */
export function commandNames(): string[] {
  const names: string[] = [];
  for (const c of COMMANDS) {
    names.push(c.name);
    for (const a of c.aliases ?? []) names.push(a);
  }
  return names.sort();
}

/** All commands in registration order — used by the REPL menu. */
export function allCommands(): readonly SlashCommand[] {
  return COMMANDS;
}

/**
 * Rank commands for the live menu: exact-prefix matches on name first, then
 * prefix matches on aliases, then substring matches on name/summary.
 * Empty query (just `/`) shows everything in registration order.
 */
export function matchCommands(query: string): SlashCommand[] {
  const raw = query.startsWith("/") ? query.slice(1) : query;
  const q = raw.toLowerCase().trim();
  if (!q) return COMMANDS.slice();
  const namePrefix: SlashCommand[] = [];
  const aliasPrefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  // Only fuzzy-match against name/alias/summary once the user has typed at
  // least three chars. Below that, prefix-only keeps the menu tight and
  // predictable.
  const allowFuzzy = q.length >= 3;
  for (const c of COMMANDS) {
    if (c.name.toLowerCase().startsWith(q)) {
      namePrefix.push(c);
      continue;
    }
    if ((c.aliases ?? []).some((a) => a.toLowerCase().startsWith(q))) {
      aliasPrefix.push(c);
      continue;
    }
    if (
      allowFuzzy &&
      (c.name.toLowerCase().includes(q) ||
        c.summary.toLowerCase().includes(q) ||
        (c.aliases ?? []).some((a) => a.toLowerCase().includes(q)))
    ) {
      contains.push(c);
    }
  }
  return [...namePrefix, ...aliasPrefix, ...contains];
}
