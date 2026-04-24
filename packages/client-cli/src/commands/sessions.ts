import { ProtocolClient } from "../protocol-client.js";
import { resolveEnv } from "../env.js";
import { setLastSessionId, getLastSessionId } from "../session-store.js";
import * as render from "../render.js";
import { C, color, fg, visibleWidth } from "../ui/colors.js";
import { roleColor } from "../ui/skin.js";
import type { SessionRecord } from "@squad/protocol";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function statusGlyph(status: SessionRecord["status"]): string {
  const ok = fg(roleColor("ok"));
  const warn = fg(roleColor("warn"));
  const muted = fg(roleColor("muted"));
  if (status === "running") return color("●", warn);
  if (status === "idle") return color("○", ok);
  return color("·", muted);
}

function printTable(rows: string[][], headers: string[]): void {
  const muted = fg(roleColor("muted"));
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  );
  process.stdout.write(
    "  " +
      headers.map((h, i) => color(h.padEnd(widths[i]!), muted)).join(color(" · ", muted)) +
      "\n",
  );
  for (const r of rows) {
    process.stdout.write(
      "  " +
        r
          .map((cell, i) => {
            const pad = Math.max(0, widths[i]! - visibleWidth(cell));
            return cell + " ".repeat(pad);
          })
          .join(color(" · ", muted)) +
        "\n",
    );
  }
}

export async function listSessions(opts: { all?: boolean; search?: string } = {}): Promise<void> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    if (opts.search) {
      const res = await client.request("session.search", { query: opts.search, limit: 50 });
      if (!res.hits.length) {
        render.renderInfo("(no results — session.search may be stubbed on this gateway)");
        return;
      }
      const rows: string[][] = [];
      for (const hit of res.hits) {
        rows.push([
          color(hit.session.id.slice(0, 8), fg(roleColor("brand"))),
          hit.session.title ?? color("(untitled)", fg(roleColor("muted"))),
          color(hit.snippet, fg(roleColor("muted"))),
        ]);
      }
      render.renderHeader(`Search "${opts.search}" (${res.hits.length})`);
      printTable(rows, ["id", "title", "snippet"]);
      return;
    }

    const { sessions } = await client.request("session.list", {
      limit: opts.all ? 200 : 50,
    });
    if (sessions.length === 0) {
      render.renderInfo("(no sessions)");
      return;
    }
    const current = getLastSessionId();
    const muted = fg(roleColor("muted"));
    const rows: string[][] = [];
    for (const s of sessions) {
      const id = color(s.id.slice(0, 8), fg(roleColor("brand")));
      const current_ = s.id === current ? color(" ←", fg(roleColor("accent"))) : "";
      const title = s.title ?? color("(untitled)", muted);
      const status = `${statusGlyph(s.status)} ${s.status}`;
      const parent = s.parentSessionId ? color("sub", muted) : "";
      const tokens = color(
        `${s.tokensIn.toLocaleString()}/${s.tokensOut.toLocaleString()}`,
        muted,
      );
      const age = color(relativeTime(s.createdAt), muted);
      rows.push([id + current_, title, status, parent, s.model, tokens, age]);
    }
    render.renderHeader(`Sessions (${sessions.length})`);
    printTable(rows, ["id", "title", "status", "kind", "model", "in/out tokens", "created"]);
    process.stdout.write("\n");
  } finally {
    client.close();
  }
}

export async function newSession(title?: string): Promise<void> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    const { session } = await client.request("session.start", { title });
    setLastSessionId(session.id);
    const brand = fg(roleColor("brand"));
    process.stdout.write(`${color(session.id, brand, C.BOLD)}${title ? "  " + title : ""}\n`);
  } finally {
    client.close();
  }
}

export async function renameSession(idPrefix: string, title: string): Promise<void> {
  if (!idPrefix || !title) throw new Error('usage: squad sessions rename <id> "new title"');
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    const { sessions } = await client.request("session.list", { limit: 200 });
    const match = sessions.find((s) => s.id === idPrefix || s.id.startsWith(idPrefix));
    if (!match) throw new Error(`no session matching "${idPrefix}"`);
    const { session } = await client.request("session.rename", {
      sessionId: match.id,
      title,
    });
    render.renderSuccess(
      `${color(session.id.slice(0, 8), fg(roleColor("brand")))} → ${session.title}`,
    );
  } finally {
    client.close();
  }
}

export async function sessionTree(idPrefix?: string): Promise<void> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    const { sessions } = await client.request("session.list", { limit: 500 });
    const root = idPrefix
      ? sessions.find((s) => s.id === idPrefix || s.id.startsWith(idPrefix))
      : sessions.find((s) => s.id === getLastSessionId());
    if (!root) {
      render.renderError(`no session matching "${idPrefix ?? "(current)"}"`);
      return;
    }
    // Walk up to the true root.
    let walker = root;
    while (walker.parentSessionId) {
      const p = sessions.find((s) => s.id === walker.parentSessionId);
      if (!p) break;
      walker = p;
    }
    const trueRoot = walker;
    render.renderHeader("Session tree");
    printNode(trueRoot, sessions, "", "");
    process.stdout.write("\n");
  } finally {
    client.close();
  }
}

function printNode(
  node: SessionRecord,
  all: SessionRecord[],
  branchPrefix: string,
  continuation: string,
): void {
  const brand = fg(roleColor("brand"));
  const muted = fg(roleColor("muted"));
  process.stdout.write(
    `${branchPrefix}${statusGlyph(node.status)} ${color(node.id.slice(0, 8), brand)}  ${node.title ?? color("(untitled)", muted)}  ${color(node.model, muted)}\n`,
  );
  const children = all.filter((s) => s.parentSessionId === node.id);
  children.forEach((c, i) => {
    const last = i === children.length - 1;
    const branch = color(last ? "└─ " : "├─ ", muted);
    const indent = color(last ? "   " : "│  ", muted);
    printNode(c, all, continuation + branch, continuation + indent);
  });
}
