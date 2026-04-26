import { useEffect, useMemo, useState } from "react";
import type { Task, SessionRecord } from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";

interface Props {
  onOpenSession: (id: string) => void;
}

interface ColumnSpec {
  id: Task["status"];
  label: string;
  dot: "off" | "accent" | "warn" | "ok" | "danger";
}

const COLUMNS: ColumnSpec[] = [
  { id: "pending", label: "pending", dot: "off" },
  { id: "in_progress", label: "in_progress", dot: "accent" },
  // Tasks blocked by other tasks land here too — see filtering below.
  { id: "completed", label: "completed", dot: "ok" },
];

export function Tasks({ onOpenSession }: Props): JSX.Element {
  const { tasks, sessions, treeSessions, activeSession, refreshSessions, createTask, updateTaskStatus } =
    useGateway();
  const [scope, setScope] = useState<"session" | "tree" | "all">("tree");
  const [ownerFilter, setOwnerFilter] = useState<"all" | "agent" | "subagent" | "user">("all");
  const [adding, setAdding] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [creating, setCreating] = useState(false);

  // Esc cancels the inline add-task form, even when focus is elsewhere
  // (e.g. user clicked away then hit esc to dismiss).
  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setAdding(false);
        setNewSubject("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding]);

  const submitNewTask = async (): Promise<void> => {
    const subject = newSubject.trim();
    if (!subject || !activeSession || creating) return;
    setCreating(true);
    try {
      await createTask(subject);
      setNewSubject("");
      setAdding(false);
    } finally {
      setCreating(false);
    }
  };

  const treeIds = useMemo(() => new Set(treeSessions.map((s) => s.id)), [treeSessions]);

  // Tasks are returned per-session today; "all" / "tree" scopes need a quick
  // multi-fetch. Keep it simple: just filter the active session's task list.
  // Future: pull every active session's tasks in parallel.
  const visible = tasks.filter((t) => {
    if (scope === "session" && activeSession && t.taskListId !== activeSession.id) return false;
    if (scope === "tree" && !treeIds.has(t.taskListId)) return false;
    if (ownerFilter !== "all" && (t.owner ?? "") !== ownerFilter) return false;
    return true;
  });

  // Reuse the Tasks structure from the design but pull a 4th "blocked" column
  // synthetically: any pending task with a non-empty blockedBy.
  const cols: Array<{ id: string; label: string; dot: ColumnSpec["dot"]; tasks: Task[] }> = [
    {
      id: "pending",
      label: "pending",
      dot: "off",
      tasks: visible.filter((t) => t.status === "pending" && t.blockedBy.length === 0),
    },
    {
      id: "in_progress",
      label: "in_progress",
      dot: "accent",
      tasks: visible.filter((t) => t.status === "in_progress"),
    },
    {
      id: "blocked",
      label: "blocked",
      dot: "warn",
      tasks: visible.filter((t) => t.blockedBy.length > 0 && t.status !== "completed" && t.status !== "deleted"),
    },
    {
      id: "completed",
      label: "completed",
      dot: "ok",
      tasks: visible.filter((t) => t.status === "completed"),
    },
  ];

  return (
    <div className="col" style={{ height: "100%", minHeight: 0 }}>
      <PageHead
        title="tasks"
        crumbs="kanban · cross-session"
        actions={
          <div className="row gap-2">
            <div
              className="row gap-2"
              style={{
                background: "var(--bg-inset)",
                border: "1px solid var(--border)",
                borderRadius: 3,
                padding: "2px 8px",
                fontSize: "var(--t-xs)",
              }}
            >
              <Icon name="filter" size={11} />
              <span className="muted">scope</span>
              <ScopeSwitch
                values={[
                  { v: "session", label: "session" },
                  { v: "tree", label: "tree" },
                  { v: "all", label: "all" },
                ]}
                cur={scope}
                onPick={(v) => setScope(v as typeof scope)}
              />
              <span className="muted">·</span>
              <span className="muted">owner</span>
              <ScopeSwitch
                values={[
                  { v: "all", label: "all" },
                  { v: "agent", label: "agent" },
                  { v: "subagent", label: "subagent" },
                  { v: "user", label: "user" },
                ]}
                cur={ownerFilter}
                onPick={(v) => setOwnerFilter(v as typeof ownerFilter)}
              />
            </div>
            <button className="btn sm ghost" onClick={() => void refreshSessions()}>
              <Icon name="filter" size={11} /> refresh
            </button>
          </div>
        }
      />
      <div className="grow" style={{ overflow: "auto", padding: 16 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            height: "100%",
            minHeight: 600,
          }}
        >
          {cols.map((c) => (
            <Card
              key={c.id}
              title={
                <span className="row gap-2">
                  <span className={"dot " + c.dot} />
                  <span style={{ marginLeft: 4 }}>{c.label}</span>
                </span>
              }
              badge={<span className="tag">{c.tasks.length}</span>}
              style={{ display: "flex", flexDirection: "column" }}
              bodyStyle={{ padding: 8, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}
            >
              {c.tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  sessions={sessions}
                  onOpenSession={onOpenSession}
                  onChangeStatus={(s) => void updateTaskStatus(t.id, s)}
                />
              ))}
              {c.id === "pending" && adding && (
                <div
                  style={{
                    background: "var(--bg-inset)",
                    border: "1px solid var(--accent-line)",
                    borderRadius: 3,
                    padding: 8,
                  }}
                  className="col gap-2"
                >
                  <input
                    className="input"
                    autoFocus
                    placeholder="task subject…"
                    value={newSubject}
                    onChange={(e) => setNewSubject(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setAdding(false);
                        setNewSubject("");
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void submitNewTask();
                      }
                    }}
                  />
                  <div className="row gap-2">
                    <span className="hint">
                      {activeSession ? `→ ${activeSession.title ?? activeSession.id.slice(-6)}` : "open a session first"}
                    </span>
                    <span className="spacer" />
                    <button
                      className="btn ghost sm"
                      onClick={() => {
                        setAdding(false);
                        setNewSubject("");
                      }}
                    >
                      cancel
                    </button>
                    <button
                      className="btn primary sm"
                      onClick={() => void submitNewTask()}
                      disabled={!activeSession || !newSubject.trim() || creating}
                    >
                      {creating ? "adding…" : "add"}
                    </button>
                  </div>
                </div>
              )}
              {c.id === "pending" && !adding && (
                <button
                  className="btn ghost sm"
                  style={{ justifyContent: "center", padding: 8 }}
                  onClick={() => setAdding(true)}
                  disabled={!activeSession}
                  title={activeSession ? "" : "open a session first"}
                >
                  <Icon name="plus" size={11} /> add task
                </button>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScopeSwitch<V extends string>({
  values,
  cur,
  onPick,
}: {
  values: Array<{ v: V; label: string }>;
  cur: V;
  onPick: (v: V) => void;
}): JSX.Element {
  return (
    <span className="row gap-1">
      {values.map((x, i) => (
        <span key={x.v} className="row gap-1">
          <span
            className={"link " + (cur === x.v ? "strong" : "muted")}
            onClick={() => onPick(x.v)}
            style={{ cursor: "pointer", color: cur === x.v ? "var(--accent)" : "var(--fg-muted)" }}
          >
            {x.label}
          </span>
          {i < values.length - 1 && <span className="dim">/</span>}
        </span>
      ))}
    </span>
  );
}

function TaskCard({
  task,
  sessions,
  onOpenSession,
  onChangeStatus,
}: {
  task: Task;
  sessions: SessionRecord[];
  onOpenSession: (id: string) => void;
  onChangeStatus: (status: Task["status"]) => void;
}): JSX.Element {
  const meta = task.metadata ?? {};
  const progress = typeof meta.progress === "number" ? meta.progress : null;
  const pri = (typeof meta.priority === "string" ? meta.priority : "med") as "high" | "med" | "low";
  const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
  const sess = sessions.find((s) => s.id === task.taskListId);
  return (
    <div
      style={{
        background: "var(--bg-inset)",
        border: "1px solid var(--border-soft)",
        borderRadius: 3,
        padding: "8px 10px",
      }}
    >
      <div className="row gap-2" style={{ marginBottom: 4 }}>
        <span className="faint mono" style={{ fontSize: 10 }}>
          {task.id.slice(-5)}
        </span>
        <span
          className={"tag " + (pri === "high" ? "warn" : "")}
          style={{ fontSize: 9 }}
        >
          {pri}
        </span>
        <span className="spacer" />
        {task.owner === "subagent" && <span className="tag info">subagent</span>}
        {task.owner === "user" && <span className="tag warn">user</span>}
        {task.owner === "agent" && <span className="tag">agent</span>}
        {task.owner && !["subagent", "user", "agent"].includes(task.owner) && (
          <span className="tag">{task.owner}</span>
        )}
      </div>
      <div
        style={{
          fontSize: "var(--t-sm)",
          color: task.status === "completed" ? "var(--fg-faint)" : "var(--fg)",
          textDecoration: task.status === "completed" ? "line-through" : "none",
          marginBottom: 6,
          lineHeight: 1.45,
        }}
      >
        {task.subject}
      </div>
      {task.activeForm && task.status === "in_progress" && (
        <div className="hint" style={{ marginBottom: 6, color: "var(--accent)" }}>
          ◐ {task.activeForm}
        </div>
      )}
      {progress != null && (
        <div className="bar" style={{ marginBottom: 6 }}>
          <span style={{ width: progress * 100 + "%" }} />
        </div>
      )}
      {task.blockedBy.length > 0 && (
        <div className="hint" style={{ color: "var(--warn)", marginBottom: 4 }}>
          ⊘ blocked · {task.blockedBy.map((id) => id.slice(-5)).join(", ")}
        </div>
      )}
      <div className="row gap-2" style={{ fontSize: "var(--t-xs)" }}>
        {tags.slice(0, 3).map((tg) => (
          <span key={tg} className="chip">
            {tg}
          </span>
        ))}
        <span className="spacer" />
        {sess && (
          <span
            className="mono link"
            onClick={() => onOpenSession(sess.id)}
            style={{ fontSize: "var(--t-xs)" }}
          >
            {sess.id.slice(-6)}
          </span>
        )}
      </div>
      <div className="row gap-1" style={{ marginTop: 6 }}>
        {task.status !== "pending" && (
          <button className="btn ghost sm" onClick={() => onChangeStatus("pending")}>
            ← pending
          </button>
        )}
        {task.status !== "in_progress" && task.status !== "completed" && (
          <button className="btn ghost sm" onClick={() => onChangeStatus("in_progress")}>
            start
          </button>
        )}
        {task.status === "in_progress" && (
          <button className="btn ghost sm" onClick={() => onChangeStatus("pending")}>
            pause
          </button>
        )}
        {task.status !== "completed" && (
          <button className="btn ghost sm" onClick={() => onChangeStatus("completed")}>
            ✓ done
          </button>
        )}
        {task.status === "completed" && (
          <button className="btn ghost sm" onClick={() => onChangeStatus("in_progress")}>
            reopen
          </button>
        )}
      </div>
    </div>
  );
}
