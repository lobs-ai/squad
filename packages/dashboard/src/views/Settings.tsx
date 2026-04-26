import { useState } from "react";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import { fmtAgo } from "../state/fmt.js";

interface Props {
  theme: string;
  setTheme: (v: string) => void;
  density: string;
  setDensity: (v: string) => void;
  accent: string;
  setAccent: (v: string) => void;
}

const SECTIONS = [
  { id: "squad", label: "squad" },
  { id: "config", label: "gateway config" },
  { id: "models", label: "models" },
  { id: "pairings", label: "pairings" },
  { id: "channels", label: "channels" },
  { id: "theme", label: "theme" },
  { id: "shortcuts", label: "shortcuts" },
] as const;

const ACCENTS: Array<{ name: string; hex: string }> = [
  { name: "squad blue", hex: "#5b8def" },
  { name: "amber", hex: "#f59e0b" },
  { name: "lime", hex: "#a3e635" },
  { name: "magenta", hex: "#c084fc" },
  { name: "cyan", hex: "#67e8f9" },
];

export function Settings({ theme, setTheme, density, setDensity, accent, setAccent }: Props): JSX.Element {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("squad");
  const { config, models, squad, peers, pairings, channels, cancelPairing } = useGateway();

  return (
    <div>
      <PageHead title="settings" crumbs={squad?.name ?? "—"} />
      <div
        style={{
          padding: 16,
          display: "grid",
          gridTemplateColumns: "180px 1fr",
          gap: 16,
        }}
      >
        <div>
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                padding: "6px 10px",
                borderLeft: "2px solid " + (section === s.id ? "var(--accent)" : "transparent"),
                background: section === s.id ? "var(--bg-card)" : "transparent",
                color: section === s.id ? "var(--fg-strong)" : "var(--fg-muted)",
                cursor: "pointer",
                fontSize: "var(--t-sm)",
              }}
            >
              {s.label}
            </div>
          ))}
        </div>
        <div>
          {section === "squad" && squad && (
            <Card title={`squad · ${squad.name}`} badge={<span className="tag ok">{squad.status}</span>}>
              <div className="row-list">
                <Row k="name" v={squad.name} />
                <Row k="port" v={`:${squad.port}`} />
                <Row k="host" v={squad.host} />
                <Row k="version" v={squad.version} />
                {squad.build && <Row k="build" v={squad.build} />}
                <Row k="started" v={squad.startedAt ? fmtAgo(squad.startedAt) : "—"} />
                <Row k="active sessions" v={String(squad.activeSessions)} />
                <Row k="total sessions" v={String(squad.totalSessions)} />
                <Row k="dashboard url" v={`${window.location.protocol}//${squad.host}:${squad.port}/`} />
                <Row k="websocket" v={`${window.location.protocol === "https:" ? "wss" : "ws"}://${squad.host}:${squad.port}/ws`} />
              </div>
              {peers.length > 1 && (
                <div className="hint" style={{ marginTop: 12 }}>
                  {peers.length - 1} sibling squad{peers.length === 2 ? "" : "s"} on this host — see the{" "}
                  <span className="link" onClick={() => undefined}>manager view</span>.
                </div>
              )}
            </Card>
          )}

          {section === "config" && config && (
            <Card title="gateway config" badge={<span className="tag">live · admin.config</span>}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--t-sm)",
                    whiteSpace: "pre",
                    background: "var(--bg-inset)",
                    padding: 12,
                    borderRadius: 3,
                    color: "var(--fg-muted)",
                  }}
                >
{`primary: ${config.primary.model}
fallbacks:${config.fallbacks.length === 0 ? " []" : ""}
${config.fallbacks.map((f) => "  - " + f.model).join("\n")}
providers:
${config.providers.map((p) => "  - " + p).join("\n")}
subagents:
  max_concurrent_global: ${config.subagents.maxConcurrentGlobal}
  max_concurrent_per_parent: ${config.subagents.maxConcurrentPerParent}
  max_tree_depth: ${config.subagents.maxTreeDepth}
approvals:
  require_for_tags: ${JSON.stringify(config.approvals.requireForTags)}
  timeout_seconds: ${config.approvals.timeoutSeconds}`}
                </div>
                <div className="row-list">
                  <Row k="primary" v={config.primary.model} />
                  <Row k="fallback count" v={String(config.fallbacks.length)} />
                  <Row k="providers" v={config.providers.join(", ") || "—"} />
                  <Row k="subagent depth cap" v={String(config.subagents.maxTreeDepth)} />
                  <Row k="approval timeout" v={`${config.approvals.timeoutSeconds}s`} />
                </div>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                edit via the gateway's <span className="kbd">config.json</span> + restart, or use <span className="kbd">squad onboard</span>.
              </div>
            </Card>
          )}
          {section === "config" && !config && <Card><div className="hint">config unavailable.</div></Card>}

          {section === "models" && (
            <Card
              title={`models · ${models.length} available`}
              badge={<span className="tag">admin.models</span>}
            >
              <div className="row-list">
                {models.length === 0 && (
                  <div className="hint" style={{ padding: 12 }}>
                    no models — wire a provider in the gateway config.
                  </div>
                )}
                {groupByProvider(models).map(([provider, list]) => (
                  <div key={provider}>
                    <div
                      style={{
                        padding: "8px 4px 4px",
                        fontSize: "var(--t-xs)",
                        textTransform: "uppercase",
                        letterSpacing: ".1em",
                        color: "var(--fg-faint)",
                      }}
                    >
                      {provider}
                    </div>
                    {list.map((m) => (
                      <div
                        key={m.id}
                        className="row gap-3"
                        style={{ padding: "6px 4px", fontSize: "var(--t-sm)" }}
                      >
                        <span className="mono strong" style={{ flex: 1 }}>
                          {m.id}
                        </span>
                        <span className="hint">{(m.contextWindow / 1000).toFixed(0)}k ctx</span>
                        {m.notes && <span className="hint">{m.notes}</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {section === "pairings" && (
            <Card
              title="browser pairings"
              badge={<span className="tag">{pairings.length}</span>}
            >
              <div className="hint" style={{ marginBottom: 10 }}>
                each pairing is a per-browser bearer token. <strong>claimed</strong> entries
                are active sessions and persist across gateway restarts; revoke one here
                to log that browser out immediately.
              </div>
              {pairings.length === 0 && <div className="hint">no pairings.</div>}
              <div className="row-list">
                {pairings.map((p) => (
                  <div
                    key={p.code}
                    className="row gap-3"
                    style={{ padding: "8px 0", fontSize: "var(--t-sm)" }}
                  >
                    <span
                      className={
                        "dot " +
                        (p.status === "claimed"
                          ? "ok"
                          : p.status === "approved"
                            ? "ok pulse"
                            : p.status === "pending"
                              ? "accent pulse"
                              : p.status === "expired"
                                ? "warn"
                                : "off")
                      }
                    />
                    <span className="mono accent" style={{ width: 130, color: "var(--accent)" }}>
                      {p.code}
                    </span>
                    <span style={{ flex: 1 }}>{p.label}</span>
                    <span className={"tag " + (p.status === "claimed" ? "ok" : "")}>
                      {p.status === "claimed" ? "active" : p.status}
                    </span>
                    {p.persistent && (
                      <span className="tag" title="persisted to <data_dir>/pairings.json — survives restarts">
                        persistent
                      </span>
                    )}
                    <span className="hint" style={{ width: 110 }}>
                      {p.claimedAt
                        ? `claimed ${fmtAgo(p.claimedAt)}`
                        : p.approvedAt
                          ? `approved ${fmtAgo(p.approvedAt)}`
                          : fmtAgo(p.createdAt)}
                    </span>
                    <span className="hint" style={{ width: 130 }}>
                      {p.approvedBy ? `by ${p.approvedBy}` : ""}
                    </span>
                    <span className="spacer" />
                    {p.status !== "expired" && p.status !== "cancelled" && (
                      <button className="btn ghost sm" onClick={() => void cancelPairing(p.code)}>
                        revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                cli: <span className="kbd">squad pair browser list</span> ·{" "}
                <span className="kbd">squad pair browser cancel &lt;code&gt;</span>
              </div>
            </Card>
          )}

          {section === "channels" && (
            <Card
              title="channels"
              badge={<span className="tag">{channels.length}</span>}
            >
              {channels.length === 0 && (
                <div className="hint">no channel plugins loaded.</div>
              )}
              <div className="row-list">
                {channels.map((c) => (
                  <div
                    key={c.id}
                    className="row gap-3"
                    style={{ padding: "8px 0", fontSize: "var(--t-sm)" }}
                  >
                    <span className={"dot " + (c.connected ? "ok" : "off")} />
                    <span className="mono" style={{ width: 80 }}>{c.kind}</span>
                    <span style={{ flex: 1 }}>{c.label}</span>
                    <span className="tag">{c.connected ? "connected" : "offline"}</span>
                  </div>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                channel allow lists live in <span className="kbd">docker/config.json</span>;
                manage them with <span className="kbd">squad pair &lt;channel&gt; &lt;user-id&gt;</span> /{" "}
                <span className="kbd">squad pair list</span>.
              </div>
            </Card>
          )}

          {section === "theme" && (
            <Card title="theme">
              <div className="col gap-3">
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    mode
                  </div>
                  <div className="row gap-2">
                    {["dark", "light", "hi-contrast"].map((t) => (
                      <button
                        key={t}
                        className={"btn sm " + (theme === t ? "primary" : "")}
                        onClick={() => setTheme(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    density
                  </div>
                  <div className="row gap-2">
                    {["comfortable", "compact"].map((t) => (
                      <button
                        key={t}
                        className={"btn sm " + (density === t ? "primary" : "")}
                        onClick={() => setDensity(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    accent
                  </div>
                  <div className="row gap-2">
                    {ACCENTS.map((c) => (
                      <button
                        key={c.name}
                        className="btn sm"
                        onClick={() => setAccent(c.hex)}
                        style={{
                          borderColor: accent === c.hex ? c.hex : "var(--border)",
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: c.hex,
                            display: "inline-block",
                          }}
                        />
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {section === "shortcuts" && (
            <Card title="keyboard">
              <div className="row-list">
                {[
                  ["⌘K", "open command palette"],
                  ["⌘N", "new chat"],
                  ["⌘↵", "send message"],
                  ["g o", "go to overview"],
                  ["g c", "go to chat"],
                  ["g t", "go to tasks"],
                  ["g s", "go to sessions"],
                  ["g p", "go to plugins"],
                  ["g m", "open manager"],
                ].map(([k, d]) => (
                  <div key={k} className="row gap-2" style={{ padding: "5px 0" }}>
                    <span className="kbd" style={{ minWidth: 56, textAlign: "center" }}>
                      {k}
                    </span>
                    <span style={{ fontSize: "var(--t-sm)" }}>{d}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="row gap-2" style={{ padding: "5px 0", fontSize: "var(--t-sm)" }}>
      <span className="faint" style={{ minWidth: 140 }}>
        {k}
      </span>
      <span className="mono">{v}</span>
    </div>
  );
}

function groupByProvider<T extends { provider: string }>(models: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const m of models) {
    const arr = groups.get(m.provider) ?? [];
    arr.push(m);
    groups.set(m.provider, arr);
  }
  return Array.from(groups.entries());
}
