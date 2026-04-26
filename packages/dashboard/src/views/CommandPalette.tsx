import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import type { ViewId } from "./views.js";

interface Props {
  open: boolean;
  onClose: () => void;
  setView: (v: ViewId) => void;
  onPickSession: (id: string) => void;
  onNewChat: () => void;
}

interface Item {
  kind: "view" | "session" | "plugin" | "action";
  icon: IconName;
  label: string;
  sub?: string;
  on?: () => void;
}

export function CommandPalette({ open, onClose, setView, onPickSession, onNewChat }: Props): JSX.Element | null {
  const { sessions, plugins } = useGateway();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open]);

  const items: Item[] = useMemo(() => {
    const base: Item[] = [
      { kind: "view", icon: "overview", label: "Go to · Overview", on: () => setView("overview") },
      { kind: "view", icon: "chat", label: "Go to · Chat", on: () => setView("chat") },
      { kind: "view", icon: "kanban", label: "Go to · Tasks", on: () => setView("tasks") },
      { kind: "view", icon: "session", label: "Go to · Sessions", on: () => setView("sessions") },
      { kind: "view", icon: "plugin", label: "Go to · Plugins", on: () => setView("plugins") },
      { kind: "view", icon: "settings", label: "Go to · Settings", on: () => setView("settings") },
      { kind: "view", icon: "manager", label: "Open · Manager Overview", on: () => setView("manager") },
      { kind: "view", icon: "spark", label: "Go to · Routines", on: () => setView("routines") },
      ...sessions.map<Item>((s) => ({
        kind: "session",
        icon: "session",
        label: "Open · " + (s.title ?? s.id),
        sub: s.id.slice(-8),
        on: () => onPickSession(s.id),
      })),
      ...plugins
        .filter((p) => p.enabled)
        .slice(0, 6)
        .map<Item>((p) => ({
          kind: "plugin",
          icon: "plugin",
          label: p.name + " · open",
          sub: p.id,
        })),
      {
        kind: "action",
        icon: "plus",
        label: "New chat…",
        sub: "⌘N",
        on: onNewChat,
      },
    ];
    return base;
  }, [sessions, plugins, setView, onPickSession, onNewChat]);

  const filt = items.filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()) || i.sub?.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (cursor >= filt.length) setCursor(0);
  }, [filt.length, cursor]);

  if (!open) return null;

  const run = (i: Item): void => {
    i.on?.();
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: 560,
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "var(--shadow-2)",
          overflow: "hidden",
        }}
      >
        <div
          className="row gap-2"
          style={{ padding: 10, borderBottom: "1px solid var(--border-soft)" }}
        >
          <Icon name="command" size={13} className="faint" />
          <input
            ref={inputRef}
            className="input"
            placeholder="jump to a session, view, or action…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(filt.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const item = filt[cursor];
                if (item) run(item);
              }
            }}
            style={{ background: "transparent", border: 0, padding: 0 }}
          />
          <span className="kbd">esc</span>
        </div>
        <div style={{ overflow: "auto", padding: 4 }}>
          {filt.length === 0 && (
            <div className="hint" style={{ padding: 12 }}>
              no matches.
            </div>
          )}
          {filt.map((i, k) => (
            <div
              key={k}
              className="row gap-2"
              onClick={() => run(i)}
              onMouseEnter={() => setCursor(k)}
              style={{
                padding: "6px 10px",
                borderRadius: 3,
                cursor: "pointer",
                background: k === cursor ? "var(--bg-hover)" : undefined,
                fontSize: "var(--t-sm)",
              }}
            >
              <span className="faint" style={{ width: 16 }}>
                <Icon name={i.icon} size={12} />
              </span>
              <span
                className="tag"
                style={{ fontSize: 9, width: 56, textAlign: "center" }}
              >
                {i.kind}
              </span>
              <span style={{ flex: 1 }}>{i.label}</span>
              {i.sub && <span className="hint mono">{i.sub}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
