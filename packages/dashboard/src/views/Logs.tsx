import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Card, PageHead } from "../ui/primitives.js";
import { useGateway } from "../state/GatewayContext.js";
import type { LogEntry, LogLevel } from "@squad/protocol";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};
const LEVEL_TONE: Record<LogLevel, string> = {
  trace: "var(--fg-faint)",
  debug: "var(--fg-muted)",
  info: "var(--ok)",
  warn: "var(--warn)",
  error: "var(--err)",
  fatal: "var(--err)",
};

const BUFFER_LIMIT = 1000;

export function Logs(): JSX.Element {
  const { client, markLogsRead } = useGateway();
  // Visiting the view acknowledges every error/fatal sitting in the buffer.
  useEffect(() => {
    markLogsRead();
  }, [markLogsRead]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [level, setLevel] = useState<LogLevel>("debug");
  const [source, setSource] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const subscribedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Initial fetch + refetch when filters change. We pull a generous window so
  // client-side filtering on level/source/q feels instant; the server still
  // applies the same predicates so very-cold buffers don't waste bytes.
  const fetchTail = useCallback(async () => {
    try {
      const r = await client.request("logs.tail", {
        limit: BUFFER_LIMIT,
        level,
        ...(source ? { source } : {}),
        ...(q ? { q } : {}),
      });
      setEntries(r.entries);
      setSources(r.sources);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, level, source, q]);

  useEffect(() => {
    void fetchTail();
  }, [fetchTail]);

  // Live-tail subscription. We keep it open for the whole view lifetime and
  // gate visibility on the current filters client-side — gateway broadcasts
  // every entry regardless of who's filtering for what.
  useEffect(() => {
    if (!subscribedRef.current) {
      void client.subscribe(["logs.entry"]).catch(() => {});
      subscribedRef.current = true;
    }
    const off = client.onEvent((topic, data) => {
      if (topic !== "logs.entry") return;
      if (paused) return;
      const entry = (data as { entry: LogEntry }).entry;
      // The user is looking at the Logs view right now — keep the badge at 0.
      if (entry.level === "error" || entry.level === "fatal") markLogsRead();
      if (!matchesFilters(entry, level, source, q)) return;
      setEntries((cur) => {
        const next = [...cur, entry];
        if (next.length > BUFFER_LIMIT) next.splice(0, next.length - BUFFER_LIMIT);
        return next;
      });
      // Track new sources as they appear so the filter dropdown stays current
      // without a refetch.
      if (entry.source) {
        setSources((cur) => (cur.includes(entry.source!) ? cur : [...cur, entry.source!].sort()));
      }
    });
    return off;
  }, [client, level, source, q, paused, markLogsRead]);

  // Auto-scroll to bottom on new entries unless the user is paused.
  useEffect(() => {
    if (paused) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, paused]);

  const visible = useMemo(() => entries, [entries]);
  const minRank = LEVEL_RANK[level];

  const toggleExpand = (id: number): void => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clear = (): void => setEntries([]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHead
        title="logs"
        crumbs={`${visible.length} entries · ${paused ? "paused" : "live"}`}
        actions={
          <div className="row gap-2">
            <button className="btn sm ghost" onClick={() => setPaused((p) => !p)}>
              {paused ? "resume" : "pause"}
            </button>
            <button className="btn sm ghost" onClick={clear}>
              clear
            </button>
            <button className="btn sm ghost" onClick={() => void fetchTail()}>
              refetch
            </button>
          </div>
        }
      />
      <div style={{ padding: "8px 16px 0 16px" }}>
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <label className="hint">level</label>
          <select
            className="input sm"
            value={level}
            onChange={(e) => setLevel(e.target.value as LogLevel)}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l} ({LEVEL_RANK[l]}+)
              </option>
            ))}
          </select>
          <label className="hint">source</label>
          <select
            className="input sm"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">all</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className="input sm"
            placeholder="search msg/bindings…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        {error && (
          <div
            className="card"
            style={{
              padding: 8,
              marginTop: 8,
              borderColor: "var(--err)",
              color: "var(--err)",
              fontSize: "var(--t-sm)",
            }}
          >
            {error}
          </div>
        )}
      </div>
      <div style={{ padding: 16, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Card
          bodyStyle={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            padding: 0,
          }}
          style={{ flex: 1, minHeight: 0 }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: "var(--t-xs)",
            }}
          >
            {visible.length === 0 ? (
              <div className="hint" style={{ padding: 14 }}>
                no log entries yet
                {minRank > 10 ? ` at ${level}+ — try lowering the level` : ""}
                {q ? ` matching "${q}"` : ""}
                {source ? ` from ${source}` : ""}.
              </div>
            ) : (
              visible.map((e) => (
                <LogRow
                  key={e.id}
                  entry={e}
                  expanded={expanded.has(e.id)}
                  onToggle={() => toggleExpand(e.id)}
                />
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const tone = LEVEL_TONE[entry.level];
  const time = entry.time.length >= 19 ? entry.time.slice(11, 23) : entry.time;
  const hasBindings = Object.keys(entry.bindings).length > 0;
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const onMouseDown = (e: ReactMouseEvent): void => {
    downPos.current = { x: e.clientX, y: e.clientY };
  };
  const onClick = (e: ReactMouseEvent): void => {
    if (!hasBindings) return;
    // Don't toggle when the user is selecting/copying text — either by
    // dragging across more than a tiny threshold, or with a non-empty
    // selection sitting on the page.
    const start = downPos.current;
    downPos.current = null;
    if (start) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx + dy > 4) return;
    }
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    onToggle();
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        padding: "3px 12px",
        borderBottom: "1px solid var(--border-soft)",
        cursor: hasBindings ? "pointer" : "default",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        userSelect: "text",
      }}
    >
      <span style={{ color: "var(--fg-faint)", flexShrink: 0, width: 84 }}>{time}</span>
      <span
        style={{
          color: tone,
          textTransform: "uppercase",
          fontWeight: 600,
          flexShrink: 0,
          width: 44,
        }}
      >
        {entry.level}
      </span>
      <span
        style={{ color: "var(--fg-muted)", flexShrink: 0, width: 140 }}
        title={entry.source ?? ""}
      >
        {entry.source ?? "—"}
      </span>
      <span style={{ flex: 1 }}>
        <span>{entry.msg || "(no message)"}</span>
        {hasBindings && !expanded && (
          <span style={{ color: "var(--fg-faint)", marginLeft: 8 }}>
            {summarizeBindings(entry.bindings)}
          </span>
        )}
        {expanded && hasBindings && (
          <pre
            // The expanded JSON is the thing people actually want to copy.
            // Stop click bubbling so a double-click-to-select doesn't also
            // collapse the row out from under them.
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              margin: "4px 0 0",
              padding: 8,
              background: "var(--bg-inset)",
              border: "1px solid var(--border-soft)",
              borderRadius: 3,
              maxHeight: 240,
              overflow: "auto",
              userSelect: "text",
              cursor: "text",
            }}
          >
            {JSON.stringify(entry.bindings, null, 2)}
          </pre>
        )}
      </span>
    </div>
  );
}

function summarizeBindings(b: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (k === "component" || k === "service" || k === "source") continue;
    let s: string;
    if (v === null || v === undefined) s = String(v);
    else if (typeof v === "string") s = v;
    else if (typeof v === "object")
      s = "err" in (v as object) || "stack" in (v as object) ? errSummary(v) : "{…}";
    else s = String(v);
    if (s.length > 60) s = s.slice(0, 57) + "…";
    parts.push(`${k}=${s}`);
    if (parts.length >= 4) {
      parts.push("…");
      break;
    }
  }
  return parts.join(" ");
}

function errSummary(v: unknown): string {
  const obj = v as { message?: string; type?: string };
  if (obj.message) return `${obj.type ?? "Error"}: ${obj.message}`;
  return JSON.stringify(v).slice(0, 60);
}

function matchesFilters(
  entry: LogEntry,
  level: LogLevel,
  source: string,
  q: string,
): boolean {
  if (LEVEL_RANK[entry.level] < LEVEL_RANK[level]) return false;
  if (source && entry.source !== source) return false;
  if (q) {
    const needle = q.toLowerCase();
    if (entry.msg.toLowerCase().includes(needle)) return true;
    if (entry.source && entry.source.toLowerCase().includes(needle)) return true;
    for (const v of Object.values(entry.bindings)) {
      if (typeof v === "string" && v.toLowerCase().includes(needle)) return true;
    }
    return false;
  }
  return true;
}
