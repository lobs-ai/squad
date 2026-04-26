import { useEffect, useMemo, useState, useCallback } from "react";
import type { SessionRecord } from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import { estimateCost, fmtAgo, fmtCost, fmtTokens, modelShort } from "../state/fmt.js";

interface Props {
  onOpenSession: (id: string) => void;
}

interface SearchHit {
  session: SessionRecord;
  snippet: string;
}

const TIME_WINDOWS: Array<{ id: "any" | "1d" | "7d" | "30d"; label: string; ms: number | null }> = [
  { id: "any", label: "any time", ms: null },
  { id: "1d", label: "24h", ms: 86_400_000 },
  { id: "7d", label: "7d", ms: 7 * 86_400_000 },
  { id: "30d", label: "30d", ms: 30 * 86_400_000 },
];

export function Sessions({ onOpenSession }: Props): JSX.Element {
  const { sessions, client, models, renameSession, setSessionModel } = useGateway();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [timeFilter, setTimeFilter] = useState<typeof TIME_WINDOWS[number]["id"]>("any");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const platforms = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.parentSessionId) set.add("subagent");
      else if (s.platform) set.add(s.platform);
      else set.add("dashboard");
    }
    return Array.from(set).sort();
  }, [sessions]);

  const sessionModels = useMemo(() => {
    const set = new Set(sessions.map((s) => s.model));
    return Array.from(set).sort();
  }, [sessions]);

  const cancelEdit = useCallback(() => setEditing(null), []);
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, cancelEdit]);

  // Sessions search uses the gateway's FTS5 endpoint when the user types into
  // the search box; otherwise we fall back to the locally cached list.
  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      void client
        .request("session.search", { query: q.trim(), limit: 50 })
        .then((r) => {
          if (cancelled) return;
          setHits(r.hits);
        })
        .catch(() => {
          if (cancelled) return;
          // Fall back to client-side substring filter on title/id.
          const lower = q.toLowerCase();
          const local: SearchHit[] = sessions
            .filter((s) => (s.title ?? "").toLowerCase().includes(lower) || s.id.includes(q))
            .map((s) => ({ session: s, snippet: "" }));
          setHits(local);
        })
        .finally(() => {
          if (cancelled) return;
          setSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, client, sessions]);

  const rawRows: SearchHit[] = useMemo(() => {
    if (hits) return hits;
    return sessions.map((s) => ({ session: s, snippet: "" }));
  }, [hits, sessions]);

  const timeWindow = TIME_WINDOWS.find((w) => w.id === timeFilter) ?? TIME_WINDOWS[0]!;
  const cutoff = timeWindow.ms != null ? Date.now() - timeWindow.ms : null;

  const rows = rawRows.filter(({ session: s }) => {
    if (platformFilter !== "all") {
      const p = s.parentSessionId ? "subagent" : s.platform ?? "dashboard";
      if (p !== platformFilter) return false;
    }
    if (modelFilter !== "all" && s.model !== modelFilter) return false;
    if (cutoff != null && Date.parse(s.createdAt) < cutoff) return false;
    return true;
  });

  return (
    <div>
      <PageHead title="sessions" crumbs="search · live-updating" />
      <div style={{ padding: 16 }}>
        <div className="card" style={{ marginBottom: 12 }}>
          <div
            className="row gap-2"
            style={{ padding: 10, borderBottom: "1px solid var(--border-soft)" }}
          >
            <Icon name="search" size={13} className="faint" />
            <input
              className="input"
              placeholder='search transcripts… (e.g. "BroadcastChannel", "protocol-client")'
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ background: "transparent", border: 0, padding: 0 }}
            />
            <span className="kbd">/</span>
          </div>
          <div className="row gap-2" style={{ padding: "6px 10px", flexWrap: "wrap" }}>
            <span className="section-label">filters</span>
            <FilterDropdown
              label="platform"
              value={platformFilter}
              options={[{ value: "all", label: "all" }, ...platforms.map((p) => ({ value: p, label: p }))]}
              onChange={setPlatformFilter}
            />
            <FilterDropdown
              label="model"
              value={modelFilter}
              options={[
                { value: "all", label: "all" },
                ...sessionModels.map((m) => ({ value: m, label: modelShort(m) })),
              ]}
              onChange={setModelFilter}
            />
            <FilterDropdown
              label="time"
              value={timeFilter}
              options={TIME_WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
              onChange={(v) => setTimeFilter(v as typeof timeFilter)}
            />
            <span className="spacer" />
            <span className="hint">
              {searching
                ? "searching…"
                : `${rows.length} of ${sessions.length} sessions`}
            </span>
          </div>
        </div>

        <Card>
          <div
            className="row gap-2"
            style={{
              padding: "6px 12px",
              color: "var(--fg-faint)",
              fontSize: "var(--t-xs)",
              textTransform: "uppercase",
              letterSpacing: ".08em",
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <span style={{ width: 12 }} />
            <span style={{ width: 96 }}>id</span>
            <span style={{ flex: 1 }}>title</span>
            <span style={{ width: 80 }}>platform</span>
            <span style={{ width: 130 }}>model</span>
            <span style={{ width: 70, textAlign: "right" }}>cost</span>
            <span style={{ width: 70, textAlign: "right" }}>tokens</span>
            <span style={{ width: 80, textAlign: "right" }}>started</span>
          </div>
          {rows.length === 0 && (
            <div className="hint" style={{ padding: 14 }}>
              no sessions match.
            </div>
          )}
          {rows.map(({ session: s, snippet }) => {
            const cost = estimateCost(s.model, s.tokensIn, s.tokensOut);
            const tokens = s.tokensIn + s.tokensOut;
            return (
              <div
                key={s.id}
                style={{
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border-soft)",
                  fontSize: "var(--t-sm)",
                }}
              >
                <div className="row gap-2">
                  <span
                    style={{ width: 12 }}
                    className={"dot " + (s.status === "running" ? "ok pulse" : "off")}
                  />
                  <span
                    className="mono link"
                    style={{ width: 96, color: "var(--accent)" }}
                    onClick={() => onOpenSession(s.id)}
                  >
                    {s.id.slice(-8)}
                  </span>
                  {editing === s.id ? (
                    <input
                      className="input"
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onBlur={() => setEditing(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const next = editDraft.trim();
                          if (next && next !== s.title) void renameSession(s.id, next);
                          setEditing(null);
                        }
                      }}
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        cursor: "text",
                      }}
                      title="click to rename · double-click to open"
                      onClick={() => {
                        setEditDraft(s.title ?? "");
                        setEditing(s.id);
                      }}
                      onDoubleClick={() => onOpenSession(s.id)}
                    >
                      {s.title ?? "(untitled — click to name)"}
                    </span>
                  )}
                  <span style={{ width: 80 }}>
                    <span
                      className={
                        "tag " + (s.platform === "discord" ? "info" : s.parentSessionId ? "accent" : "")
                      }
                    >
                      {s.parentSessionId ? "subagent" : (s.platform ?? "dashboard")}
                    </span>
                  </span>
                  <SessionRowModel
                    session={s}
                    models={models}
                    onPick={(m) => void setSessionModel(s.id, m)}
                  />
                  <span className="mono" style={{ width: 70, textAlign: "right" }}>
                    {fmtCost(cost)}
                  </span>
                  <span className="mono" style={{ width: 70, textAlign: "right" }}>
                    {fmtTokens(tokens)}
                  </span>
                  <span
                    className="mono faint"
                    style={{ width: 80, textAlign: "right", fontSize: "var(--t-xs)" }}
                  >
                    {fmtAgo(s.createdAt)}
                  </span>
                </div>
                {snippet && (
                  <div
                    className="hint"
                    style={{
                      paddingLeft: 110,
                      marginTop: 4,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={snippet}
                  >
                    {snippet}
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}): JSX.Element {
  const cur = options.find((o) => o.value === value);
  return (
    <span
      className={"chip " + (value === "all" || value === "any" ? "" : "on")}
      style={{ cursor: "pointer", padding: 0 }}
    >
      <span style={{ padding: "1px 0 1px 6px" }}>{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          padding: "1px 6px",
          appearance: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="dim" style={{ paddingRight: 4 }}>
        {cur?.label === value ? "" : ""}
      </span>
    </span>
  );
}

function SessionRowModel({
  session,
  models,
  onPick,
}: {
  session: SessionRecord;
  models: Array<{ id: string; displayName: string; provider: string }>;
  onPick: (model: string) => void;
}): JSX.Element {
  // Inline `select` so the model column does double-duty as a swap menu.
  return (
    <span style={{ width: 130 }}>
      <select
        value={session.model}
        onChange={(e) => {
          if (e.target.value !== session.model) onPick(e.target.value);
        }}
        onClick={(e) => e.stopPropagation()}
        title="change the model used for the next turn"
        className="mono faint"
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          fontSize: "var(--t-xs)",
          maxWidth: 130,
          appearance: "none",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {models.find((m) => m.id === session.model) == null && (
          <option value={session.model}>{modelShort(session.model)}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelShort(m.id)}
          </option>
        ))}
      </select>
    </span>
  );
}
