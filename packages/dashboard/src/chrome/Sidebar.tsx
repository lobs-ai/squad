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
  const { sessions, plugins, tasks, routines, activeSessionId, setActiveSessionId, unreadLogErrors } = useGateway();

  const runningChildrenByParent = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    if (s.parentSessionId && s.status === "running") {
      const list = runningChildrenByParent.get(s.parentSessionId) ?? [];
      list.push(s);
      runningChildrenByParent.set(s.parentSessionId, list);
    }
  }

  const activeRoots = sessions.filter(
    (s) =>
      !s.parentSessionId &&
      (s.status === "running" || runningChildrenByParent.has(s.id)),
  );

  const recent = sessions
    .filter((s) => s.status !== "running" && !s.parentSessionId)
    .slice(0, 6);

  const runningCount = sessions.filter((s) => s.status === "running").length;
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
      {indent > 0 && (
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
          <span className="hint">{runningCount} streaming</span>
        </div>
      </div>
      {activeRoots.length === 0 ? (
        <div style={{ padding: "4px 12px" }}>
          <span className="hint">no active sessions</span>
        </div>
      ) : (
        activeRoots.flatMap((root) => {
          const kids = runningChildrenByParent.get(root.id) ?? [];
          return [
            <SItem key={root.id} s={root} indent={0} />,
            ...kids.map((k) => <SItem key={k.id} s={k} indent={1} />),
          ];
        })
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
        <span className="lbl">all sessions</span>
      </div>
      <div className="side-item" onClick={() => setView("search")}>
        <Icon name="search" size={12} />
        <span className="lbl">search</span>
      </div>
      <div className="side-item" onClick={() => setView("plugins")}>
        <Icon name="plugin" size={12} />
        <span className="lbl">plugins</span>
        <span className="meta">{plugins.length}</span>
      </div>
      <div className="side-item" onClick={() => setView("apps")}>
        <Icon name="manager" size={12} />
        <span className="lbl">apps</span>
      </div>
      <div className="side-item" onClick={() => setView("routines")}>
        <Icon name="spark" size={12} />
        <span className="lbl">cron</span>
        <span className="meta">{routines.length}</span>
      </div>
      <div className="side-item" onClick={() => setView("logs")}>
        <Icon name="logs" size={12} />
        <span className="lbl">logs</span>
        {unreadLogErrors > 0 && (
          <span
            className="meta"
            style={{ background: "var(--err)", color: "var(--bg)" }}
          >
            {unreadLogErrors > 99 ? "99+" : unreadLogErrors}
          </span>
        )}
      </div>
    </div>
  );
}
