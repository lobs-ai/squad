import type { PeerRecord } from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useBranding, useGateway } from "../state/GatewayContext.js";
import { fmtAgo } from "../state/fmt.js";

interface Props {
  onPickPeer: (peer: PeerRecord) => void;
}

export function Manager({ onPickPeer }: Props): JSX.Element {
  const { squad, peers, sessions, pendingQuestions, pendingApprovals, activity } = useGateway();
  const branding = useBranding();

  const knownPeers: PeerRecord[] =
    peers.length > 0
      ? peers
      : squad
        ? [
            {
              name: squad.name,
              port: squad.port,
              url: `ws://${squad.host}:${squad.port}/ws`,
              status: squad.status === "healthy" ? "healthy" : "unhealthy",
              build: squad.build === "—" ? null : squad.build,
              startedAt: squad.startedAt,
            },
          ]
        : [];

  const total = {
    squads: knownPeers.length,
    sessions: sessions.filter((s) => !s.parentSessionId).length,
    questions: pendingQuestions.length,
    approvals: pendingApprovals.length,
  };

  const stats = [
    {
      l: "squads",
      v: total.squads,
      sub: total.squads === 0 ? "—" : `${knownPeers.filter((p) => p.status === "healthy").length} healthy`,
    },
    { l: "sessions", v: total.sessions, sub: "this squad" },
    {
      l: "questions",
      v: total.questions,
      sub: "open",
      color: total.questions ? "accent" : null,
    },
    {
      l: "approvals",
      v: total.approvals,
      sub: "pending",
      color: total.approvals ? "warn" : null,
    },
  ];

  return (
    <div>
      <PageHead
        title="manager"
        crumbs={`${total.squads} squad${total.squads === 1 ? "" : "s"} on this host`}
        actions={
          <div className="row gap-2">
            <span className="hint" title="Lifecycle still lives in `squad mgr` for v1.">
              new squad: <span className="kbd">squad mgr new &lt;name&gt;</span>
            </span>
          </div>
        }
      />
      <div style={{ padding: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {stats.map((x) => (
            <div
              key={x.l}
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "10px 12px",
              }}
            >
              <div className="section-label">{x.l}</div>
              <div className="row gap-2" style={{ alignItems: "baseline", marginTop: 2 }}>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--t-2xl)",
                    color:
                      x.color === "accent"
                        ? "var(--accent)"
                        : x.color === "warn"
                          ? "var(--warn)"
                          : "var(--fg-strong)",
                  }}
                >
                  {x.v}
                </span>
                <span className="hint">{x.sub}</span>
              </div>
            </div>
          ))}
        </div>

        <Card title="squads" badge={<span className="tag">{knownPeers.length}</span>}>
          <div className="row-list">
            <div
              className="row gap-2"
              style={{
                padding: "4px 0",
                color: "var(--fg-faint)",
                fontSize: "var(--t-xs)",
                textTransform: "uppercase",
                letterSpacing: ".08em",
              }}
            >
              <span style={{ width: 14 }} />
              <span style={{ width: 110 }}>name</span>
              <span style={{ width: 60 }}>port</span>
              <span style={{ width: 100 }}>status</span>
              <span style={{ width: 110 }}>build</span>
              <span style={{ width: 110 }}>started</span>
              <span className="spacer" />
              <span>actions</span>
            </div>
            {knownPeers.map((s) => {
              const isSelf = squad?.name === s.name;
              return (
                <div
                  key={s.name + ":" + s.port}
                  className="row gap-2"
                  style={{ padding: "8px 0", fontSize: "var(--t-sm)" }}
                >
                  <span
                    className={
                      "dot " +
                      (s.status === "healthy"
                        ? "ok pulse"
                        : s.status === "starting"
                          ? "warn"
                          : s.status === "stopped"
                            ? "off"
                            : s.status === "unhealthy"
                              ? "danger"
                              : "off")
                    }
                    style={{ width: 14 }}
                  />
                  <span className="strong" style={{ width: 110 }}>
                    {s.name}
                    {isSelf && (
                      <span className="tag" style={{ marginLeft: 6, fontSize: 9 }}>
                        you
                      </span>
                    )}
                  </span>
                  <span className="mono faint" style={{ width: 60 }}>
                    :{s.port}
                  </span>
                  <span style={{ width: 100 }} className={s.status === "healthy" ? "" : "muted"}>
                    {s.status}
                  </span>
                  <span className="mono faint" style={{ width: 110, fontSize: "var(--t-xs)" }}>
                    {s.build ?? "—"}
                  </span>
                  <span className="mono faint" style={{ width: 110, fontSize: "var(--t-xs)" }}>
                    {s.startedAt ? fmtAgo(s.startedAt) : "—"}
                  </span>
                  <span className="spacer" />
                  {s.status === "healthy" || s.status === "unknown" ? (
                    <button
                      className={"btn sm " + (isSelf ? "" : "primary")}
                      onClick={() => onPickPeer(s)}
                    >
                      {isSelf ? "open" : "enter ↗"}
                    </button>
                  ) : s.status === "stopped" ? (
                    <>
                      <button className="btn sm" disabled title="run `squad mgr start` to bring this squad up">
                        start
                      </button>
                      <button className="btn sm ghost">logs</button>
                    </>
                  ) : (
                    <span className="hint pulse">{s.status}…</span>
                  )}
                </div>
              );
            })}
            {knownPeers.length === 0 && (
              <div className="hint" style={{ padding: 14 }}>
                no squad metadata available — use <span className="kbd">squad mgr ls</span> in a terminal.
              </div>
            )}
          </div>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Card
            title={`cross-squad needs ${branding.userName}`}
            accent
            badge={<span className="tag accent">{total.questions + total.approvals}</span>}
          >
            <div className="col gap-2">
              {pendingQuestions.length === 0 && pendingApprovals.length === 0 && (
                <div className="hint">no open prompts.</div>
              )}
              {pendingQuestions.map((q) => (
                <div key={q.id} className="row gap-2" style={{ fontSize: "var(--t-sm)" }}>
                  <Icon name="ask" size={12} style={{ color: "var(--accent)" }} />
                  <span className="tag">{squad?.name ?? "—"}</span>
                  <span style={{ flex: 1 }}>{q.input.questions[0]?.question ?? ""}</span>
                  <span className="hint">{fmtAgo(q.askedAt)}</span>
                </div>
              ))}
              {pendingApprovals.map((a) => (
                <div key={a.id} className="row gap-2" style={{ fontSize: "var(--t-sm)" }}>
                  <Icon name="lock" size={12} style={{ color: "var(--warn)" }} />
                  <span className="tag">{squad?.name ?? "—"}</span>
                  <span
                    className="mono"
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.toolName}
                  </span>
                  <span className="hint">{fmtAgo(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="cross-squad activity" badge={<span className="tag">merged stream</span>}>
            <div className="col">
              {activity.length === 0 && <div className="hint">no recent activity.</div>}
              {activity.slice(0, 12).map((e) => (
                <div
                  key={e.id}
                  className="row gap-2"
                  style={{
                    padding: "5px 0",
                    borderBottom: "1px solid var(--border-soft)",
                    fontSize: "var(--t-sm)",
                  }}
                >
                  <span className="mono faint" style={{ width: 56, fontSize: "var(--t-xs)" }}>
                    {fmtAgo(e.at)}
                  </span>
                  <span className="tag accent">{squad?.name ?? "—"}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.text}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
