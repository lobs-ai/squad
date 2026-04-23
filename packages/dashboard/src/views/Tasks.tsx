import type { Task } from "@squad/protocol";

const STATUS_GLYPH: Record<Task["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  deleted: "×",
};

export function Tasks({ tasks }: { tasks: Task[] }): JSX.Element {
  if (tasks.length === 0) {
    return <div className="empty">No tasks yet.</div>;
  }
  return (
    <div className="tasks-panel">
      <h2>Task list</h2>
      {tasks.map((t) => (
        <div key={t.id} className={`task-row ${t.status}`}>
          <span className="glyph">{STATUS_GLYPH[t.status]}</span>
          <div className="content">
            <div className="subject">{t.subject}</div>
            <div className="description">{t.description}</div>
            {t.owner && <div className="owner">owner: {t.owner}</div>}
            {t.blockedBy.length > 0 && (
              <div className="blocked">blocked by: {t.blockedBy.join(", ")}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
