import { ProtocolClient } from "../protocol-client.js";
import { resolveEnv } from "../env.js";
import { C, color, fg } from "../ui/colors.js";
import { roleColor } from "../ui/skin.js";
import type { LogEntry, LogLevel } from "@squad/protocol";

const LEVEL_INFO: Record<
  LogLevel,
  { label: string; role: string; rank: number }
> = {
  trace: { label: "TRACE", role: "muted", rank: 10 },
  debug: { label: "DEBUG", role: "muted", rank: 20 },
  info: { label: "INFO ", role: "ok", rank: 30 },
  warn: { label: "WARN ", role: "warn", rank: 40 },
  error: { label: "ERROR", role: "err", rank: 50 },
  fatal: { label: "FATAL", role: "err", rank: 60 },
};

export interface TailOptions {
  follow: boolean;
  level: LogLevel;
  source?: string;
  query?: string;
  limit: number;
}

export async function runTail(opts: TailOptions): Promise<void> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  let lastId = 0;
  try {
    const initial = await client.request("logs.tail", {
      limit: opts.limit,
      level: opts.level,
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.query ? { q: opts.query } : {}),
    });
    for (const e of initial.entries) {
      process.stdout.write(formatEntry(e) + "\n");
      if (e.id > lastId) lastId = e.id;
    }
    if (!opts.follow) return;

    // Live tail. We subscribe to the broadcast topic and filter client-side
    // so the gateway doesn't have to track our predicates.
    const minRank = LEVEL_INFO[opts.level].rank;
    await client.subscribe(["logs.entry"]);
    client.onEvent((topic, data) => {
      if (topic !== "logs.entry") return;
      const entry = (data as { entry: LogEntry }).entry;
      if (LEVEL_INFO[entry.level].rank < minRank) return;
      if (opts.source && entry.source !== opts.source) return;
      if (opts.query && !matchesQuery(entry, opts.query)) return;
      if (entry.id <= lastId) return;
      lastId = entry.id;
      process.stdout.write(formatEntry(entry) + "\n");
    });

    // Block until the user kills the process.
    await new Promise<void>(() => {
      process.on("SIGINT", () => {
        client.close();
        process.exit(0);
      });
    });
  } finally {
    if (!opts.follow) client.close();
  }
}

function formatEntry(e: LogEntry): string {
  const info = LEVEL_INFO[e.level] ?? LEVEL_INFO.info;
  const muted = fg(roleColor("muted"));
  const levelColor = fg(roleColor(info.role));
  const time = e.time.length >= 19 ? e.time.slice(11, 19) : e.time;
  const source = e.source ? ` ${color(e.source, muted)}` : "";

  // Render bindings as a compact k=v tail. Skip the source-ish keys we
  // already printed inline so the output stays readable.
  const skip = new Set(["component", "service", "source"]);
  const extras: string[] = [];
  for (const [k, v] of Object.entries(e.bindings)) {
    if (skip.has(k)) continue;
    if (v === undefined) continue;
    let s: string;
    if (typeof v === "string") s = v;
    else if (typeof v === "object" && v !== null) {
      const o = v as { message?: string; type?: string };
      s = o.message ? `${o.type ?? "Error"}: ${o.message}` : JSON.stringify(v);
    } else s = String(v);
    if (s.length > 200) s = s.slice(0, 197) + "…";
    extras.push(`${muted}${k}${C.RESET}=${s}`);
  }
  const extraStr = extras.length ? " " + extras.join(" ") : "";
  return `${color(time, muted)} ${color(info.label, levelColor, C.BOLD)}${source}  ${e.msg}${extraStr}`;
}

function matchesQuery(e: LogEntry, q: string): boolean {
  const needle = q.toLowerCase();
  if (e.msg.toLowerCase().includes(needle)) return true;
  if (e.source && e.source.toLowerCase().includes(needle)) return true;
  for (const v of Object.values(e.bindings)) {
    if (typeof v === "string" && v.toLowerCase().includes(needle)) return true;
  }
  return false;
}
