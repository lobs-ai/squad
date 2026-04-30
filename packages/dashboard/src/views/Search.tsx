import { useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import type { sessionSearchHit } from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import { usePersistedState } from "../state/usePersistedState.js";

type SessionSearchHit = z.infer<typeof sessionSearchHit>;

const DEBOUNCE_MS = 200;

interface SearchViewProps {
  onOpenSession: (sessionId: string) => void;
}

export function SearchView({ onOpenSession }: SearchViewProps): JSX.Element {
  const { client } = useGateway();
  const [q, setQ] = usePersistedState("squad-search-q", "");
  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on first render — search-as-you-type benefits from
  // immediate keyboard input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search effect.
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      let cancelled = false;
      void client
        .request("session.search", { query: trimmed, limit: 50 })
        .then((res) => {
          if (cancelled) return;
          setHits(res.hits);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError((err as Error).message);
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [q, client]);

  const grouped = useMemo(() => groupBySession(hits), [hits]);

  return (
    <div>
      <PageHead title="search" crumbs="full-text across all session transcripts" />
      <div style={{ padding: 16, display: "grid", gap: 12 }}>
        <Card>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              className="input"
              style={{ flex: 1 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search across messages…"
            />
            {loading && <span className="hint">searching…</span>}
          </div>
        </Card>

        {error && (
          <Card>
            <div className="hint" style={{ color: "var(--danger)" }}>
              {error}
            </div>
          </Card>
        )}

        {!loading && !error && q.trim().length === 0 && (
          <Card>
            <div className="hint">
              type to search every message in every session. results group by session.
            </div>
          </Card>
        )}

        {!loading && !error && q.trim().length > 0 && hits.length === 0 && (
          <Card>
            <div className="hint">no matches.</div>
          </Card>
        )}

        {grouped.map((g) => (
          <Card
            key={g.sessionId}
            title={g.title || g.sessionId.slice(0, 8)}
            badge={<span className="tag">{g.hits.length}</span>}
          >
            <div className="row-list">
              {g.hits.map((h) => (
                <div
                  key={h.messageId}
                  className="row gap-3"
                  style={{ alignItems: "center", padding: "6px 0", cursor: "pointer" }}
                  onClick={() => onOpenSession(h.sessionId)}
                  title="open session in chat"
                >
                  <span className="mono faint" style={{ minWidth: 80 }}>
                    {new Date(h.ts).toLocaleString()}
                  </span>
                  <span className="hint" style={{ flex: 1 }}>
                    <Snippet text={h.snippet} />
                  </span>
                  <span className="hint">score {h.score.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function groupBySession(
  hits: SessionSearchHit[],
): Array<{ sessionId: string; title: string | null; hits: SessionSearchHit[] }> {
  const map = new Map<string, { title: string | null; hits: SessionSearchHit[] }>();
  for (const h of hits) {
    const cur = map.get(h.sessionId);
    if (cur) {
      cur.hits.push(h);
    } else {
      map.set(h.sessionId, { title: h.session.title, hits: [h] });
    }
  }
  return Array.from(map.entries()).map(([sessionId, v]) => ({
    sessionId,
    title: v.title,
    hits: v.hits,
  }));
}

/**
 * Render a server-produced FTS5 snippet by turning the `<<...>>` markers
 * into highlight spans without going anywhere near `dangerouslySetInnerHTML`.
 */
function Snippet({ text }: { text: string }): JSX.Element {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<<", i);
    if (open < 0) {
      parts.push({ text: text.slice(i), hit: false });
      break;
    }
    if (open > i) parts.push({ text: text.slice(i, open), hit: false });
    const close = text.indexOf(">>", open + 2);
    if (close < 0) {
      parts.push({ text: text.slice(open + 2), hit: false });
      break;
    }
    parts.push({ text: text.slice(open + 2, close), hit: true });
    i = close + 2;
  }
  return (
    <>
      {parts.map((p, idx) =>
        p.hit ? (
          <mark key={idx} style={{ background: "var(--accent-line)", color: "inherit" }}>
            {p.text}
          </mark>
        ) : (
          <span key={idx}>{p.text}</span>
        ),
      )}
    </>
  );
}
