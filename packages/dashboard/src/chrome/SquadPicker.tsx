import { useEffect, useRef, useState } from "react";
import type { PeerRecord } from "@squad/protocol";
import { Icon } from "../ui/Icon.js";
import type { SquadIdentity } from "../state/GatewayContext.js";

interface Props {
  squad: SquadIdentity | null;
  peers: PeerRecord[];
  onPickPeer: (peer: PeerRecord) => void;
  onOpenManager: () => void;
}

export function SquadPicker({ squad, peers, onPickPeer, onOpenManager }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const status = squad?.status ?? "stopped";
  const dotClass =
    status === "healthy"
      ? "dot ok"
      : status === "starting"
        ? "dot warn"
        : status === "stopped"
          ? "dot off"
          : "dot danger";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div className="squad-picker" onClick={() => setOpen((o) => !o)}>
        <span className={dotClass} />
        <span className="strong">squad</span>
        <span className="muted">/</span>
        <span>{squad?.name ?? "—"}</span>
        <Icon name="chevron-down" size={12} className="faint" />
      </div>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            width: 320,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-2)",
            zIndex: 30,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 10px 4px",
              fontSize: "var(--t-xs)",
              color: "var(--fg-faint)",
              textTransform: "uppercase",
              letterSpacing: ".12em",
            }}
          >
            squads · {peers.length || 1} (this host)
          </div>
          {peers.map((p) => (
            <div
              key={p.name + ":" + p.port}
              className="row"
              onClick={() => {
                onPickPeer(p);
                setOpen(false);
              }}
              style={{
                padding: "6px 10px",
                gap: 8,
                cursor: p.name === squad?.name ? "default" : "pointer",
                background: p.name === squad?.name ? "var(--bg-hover)" : "transparent",
              }}
            >
              <span
                className={
                  "dot " +
                  (p.status === "healthy"
                    ? "ok"
                    : p.status === "starting"
                      ? "warn"
                      : p.status === "stopped"
                        ? "off"
                        : "off")
                }
              />
              <span className="strong" style={{ width: 80 }}>
                {p.name}
              </span>
              <span className="muted" style={{ fontSize: "var(--t-xs)" }}>
                :{p.port}
              </span>
              <span className="spacer" />
              <span className="faint" style={{ fontSize: "var(--t-xs)" }}>
                {p.status}
              </span>
            </div>
          ))}
          {peers.length === 0 && squad && (
            <div className="row" style={{ padding: "6px 10px", gap: 8, cursor: "default", background: "var(--bg-hover)" }}>
              <span className={dotClass} />
              <span className="strong" style={{ width: 80 }}>
                {squad.name}
              </span>
              <span className="muted" style={{ fontSize: "var(--t-xs)" }}>
                :{squad.port}
              </span>
              <span className="spacer" />
              <span className="faint" style={{ fontSize: "var(--t-xs)" }}>
                {squad.status}
              </span>
            </div>
          )}
          <div className="hairline-top">
            <div
              className="row"
              onClick={() => {
                onOpenManager();
                setOpen(false);
              }}
              style={{ padding: "8px 10px", gap: 8, cursor: "pointer", color: "var(--accent)" }}
            >
              <Icon name="manager" size={12} /> open manager overview
            </div>
            <div
              className="row"
              style={{ padding: "8px 10px 10px", gap: 8, cursor: "default" }}
              title="Lifecycle (create / rm / start / stop) lives in the squad mgr CLI for v1."
            >
              <Icon name="plus" size={12} />
              <span className="muted">new squad…</span>
              <span className="spacer" />
              <span className="kbd">squad mgr new</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
