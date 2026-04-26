import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import type { ViewId } from "../views/views.js";
import type { SessionRecord } from "@squad/protocol";

interface Props {
  view: ViewId;
  setView: (v: ViewId) => void;
  onNewChat: () => void;
}

export function Sidebar({ setView, onNewChat }: Props): JSX.Element {
  const { sessions, plugins, tasks, routines, activeSessionId, setActiveSessionId } = useGateway();

  const active = sessions.filter((s) => s.status === "running" || s.parentSessionId);
  const recent = sessions
    .filter((s) => s.status !== "running" && !s.parentSessionId)
    .slice(0, 6);

  const openSessions = sessions.filter((s) => s.status === "running").length;
  const openTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "deleted").length;

  const SItem = ({ s, indent }: { s: SessionRecord; indent: number }): JSX.Element => (
    <div
      className={"side-item " + (activeSessionId === s.id ? "active" : "")}
      onClick={() => {
        setActiveSessionId(s.id);
        setView("chat");
      }}
      style={{ paddingLeft: 10 + indent * 12 }}
    >
      {s.parentSessionId && (
        <span className="dim mono" style={{ fontSize: 10 }}>
          └─
        </span>
      )}
      <span className={"dot " + (s.status === "running" ? "ok pulse" : "off")} />
      <span className="lbl">{s.title ?? s.id}</span>
    </div>
  );

  return (
    <div className="sidebar">
      <div style={{ padding: "10px 12px 8px" }}>
        <button
          className="btn primary"
          onClick={onNewChat}
          style={{ width: "100%", justifyContent: "center", gap: 6 }}
          title="Start a new chat session (⌘N)"
        >
          <Icon name="plus" size={12} />
          <span>new chat</span>
        </button>
      </div>
      <div className="side-section">
        <div className="row gap-2" style={{ marginBottom: 4 }}>
          <span className="section-label">active</span>
          <span className="spacer" />
          <span className="hint">{openSessions} streaming</span>
        </div>
      </div>
      {active.length === 0 ? (
        <div style={{ padding: "4px 12px" }}>
          <span className="hint">no active sessions</span>
        </div>
      ) : (
        active.map((s) => <SItem key={s.id} s={s} indent={s.parentSessionId ? 1 : 0} />)
      )}

      <div className="side-section" style={{ marginTop: 12 }}>
        <div className="row gap-2" style={{ marginBottom: 4 }}>
          <span className="section-label">recent</span>
          <span className="spacer" />
          <span className="hint">{recent.length}</span>
        </div>
      </div>
      {recent.map((s) => (
        <SItem key={s.id} s={s} indent={0} />
      ))}

      <div className="side-section" style={{ marginTop: 16 }}>
        <div className="section-label" style={{ marginBottom: 4 }}>
          quick
        </div>
      </div>
      <div className="side-item" onClick={() => setView("tasks")}>
        <Icon name="tasks" size={12} />
        <span className="lbl">all tasks</span>
        <span className="meta">{openTasks}</span>
      </div>
      <div className="side-item" onClick={() => setView("sessions")}>
        <Icon name="logs" size={12} />
        <span className="lbl">all sessions · search</span>
      </div>
      <div className="side-item" onClick={() => setView("plugins")}>
        <Icon name="plugin" size={12} />
        <span className="lbl">plugins</span>
        <span className="meta">{plugins.length}</span>
      </div>
      <div className="side-item" onClick={() => setView("routines")}>
        <Icon name="spark" size={12} />
        <span className="lbl">routines</span>
        <span className="meta">{routines.length}</span>
      </div>
    </div>
  );
}
