import type { SessionRecord } from "@squad/protocol";

export function Sessions({
  sessions,
  activeId,
}: {
  sessions: SessionRecord[];
  activeId: string | undefined;
}): JSX.Element {
  if (sessions.length === 0) return <div className="empty">No sessions yet.</div>;
  return (
    <div className="sessions-panel">
      <h2>Sessions</h2>
      {sessions.map((s) => (
        <div key={s.id} className={`session-row ${s.id === activeId ? "active" : ""}`}>
          <div className="title">{s.title ?? "(untitled)"}</div>
          <div className="meta">
            <span className={`status ${s.status}`}>{s.status}</span>
            <span className="model">{s.model}</span>
            <span className="tokens">{s.tokensIn + s.tokensOut} tokens</span>
          </div>
        </div>
      ))}
    </div>
  );
}
