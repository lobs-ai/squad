import { useMemo, useState } from "react";
import type { ApprovalRecord, PluginRecord, QuestionRecord, SessionRecord, Task } from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { useBranding, useGateway, type ActivityItem, type SubagentTreeNode } from "../state/GatewayContext.js";
import type { ViewId } from "./views.js";
import { fmtAgo, modelFamily } from "../state/fmt.js";

interface Props {
  setView: (v: ViewId) => void;
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
}

export function Overview({ setView, onOpenSession, onNewChat }: Props): JSX.Element {
  const {
    squad,
    sessions,
    pendingQuestions,
    pendingApprovals,
    activity,
    tasks,
    rootSession,
    subagentTree,
    answerQuestion,
    dismissQuestion,
    decideApproval,
    dismissApproval,
    plugins,
  } = useGateway();

  const subagentSessions = sessions.filter((s) => !!s.parentSessionId);

  return (
    <div>
      <PageHead
        title="overview"
        crumbs={squad?.name ?? "—"}
        actions={
          <div className="row gap-2">
            <button className="btn sm primary" onClick={onNewChat}>
              <Icon name="plus" size={11} /> new chat
            </button>
            <button className="btn sm ghost" onClick={() => setView("sessions")}>
              <Icon name="logs" size={11} /> all sessions
            </button>
          </div>
        }
      />
      <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <ActiveWork
          sessions={sessions}
          subagentSessions={subagentSessions}
          tasks={tasks}
          rootTitle={rootSession?.title ?? null}
          rootId={rootSession?.id ?? null}
          tree={subagentTree}
        />
        <NeedsYou
          questions={pendingQuestions}
          approvals={pendingApprovals}
          onOpenSession={onOpenSession}
          onAnswer={(qid, answers) => void answerQuestion(qid, answers)}
          onDecide={(id, dec) => void decideApproval(id, dec)}
          onDismissQuestion={(qid) => void dismissQuestion(qid)}
          onDismissApproval={(id) => void dismissApproval(id)}
        />
        <RecentActivity activity={activity} onOpenSession={onOpenSession} />
        <SharedTaskList tasks={tasks} sessions={sessions} setView={setView} />
      </div>
      <PluginWidgetsSection plugins={plugins} />
    </div>
  );
}

// ── Active work ─────────────────────────────────────────────────────────────

interface ActiveWorkProps {
  sessions: SessionRecord[];
  subagentSessions: SessionRecord[];
  tasks: Task[];
  rootTitle: string | null;
  rootId: string | null;
  tree: SubagentTreeNode | null;
}

function ActiveWork({ sessions, subagentSessions, tasks, rootTitle, rootId, tree }: ActiveWorkProps): JSX.Element {
  const streaming = sessions.filter((s) => s.status === "running");
  // Group subagents by their actual model family — no assumptions about which
  // providers/sizes the user has wired up. Falls back to "none active" when
  // no subagent sessions exist.
  const subBreakdown = (() => {
    if (subagentSessions.length === 0) return "none active";
    const counts = new Map<string, number>();
    for (const s of subagentSessions) {
      const family = modelFamily(s.model);
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([family, n]) => `${n} ${family}`)
      .join(" · ");
  })();

  const inProgressTasks = tasks.filter((t) => t.status === "in_progress");

  const stats: Array<{ n: number; l: string; sub: string; icon: "session" | "spawn" | "tasks" }> = [
    { n: sessions.filter((s) => !s.parentSessionId).length, l: "sessions", sub: streaming.length + " streaming", icon: "session" },
    { n: subagentSessions.length, l: "subagents", sub: subBreakdown, icon: "spawn" },
    { n: inProgressTasks.length, l: "tasks", sub: "in_progress", icon: "tasks" },
  ];

  return (
    <Card title="active work" badge={<span className="tag accent">live</span>} actions={<span className="hint">just now</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {stats.map((x) => (
          <div
            key={x.l}
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--radius-sm)",
              padding: "10px 12px",
            }}
          >
            <div
              className="row gap-2"
              style={{
                color: "var(--fg-faint)",
                fontSize: "var(--t-xs)",
                textTransform: "uppercase",
                letterSpacing: ".1em",
              }}
            >
              <Icon name={x.icon} size={11} /> {x.l}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--t-3xl)",
                lineHeight: 1,
                color: "var(--fg-strong)",
                marginTop: 4,
                fontWeight: 500,
              }}
            >
              {x.n}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {x.sub}
            </div>
          </div>
        ))}
      </div>
      {tree && (
        <div style={{ marginTop: 14 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>
            session tree · {rootId ?? tree.sessionId}
          </div>
          <SubagentMiniTree node={tree} title={rootTitle} />
        </div>
      )}
    </Card>
  );
}

function SubagentMiniTree({ node, title }: { node: SubagentTreeNode; title: string | null }): JSX.Element {
  const Node = ({ n, root, label }: { n: SubagentTreeNode; root?: boolean; label?: string }): JSX.Element => (
    <div
      style={{
        padding: "5px 9px",
        border: "1px solid var(--border)",
        borderRadius: 3,
        background: root ? "var(--bg-elevated)" : "var(--bg-inset)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--t-sm)",
        boxShadow: n.status === "running" ? "0 0 0 1px var(--accent-line)" : undefined,
      }}
    >
      <span
        className={
          "dot " +
          (n.status === "running"
            ? "ok pulse"
            : n.status === "completed"
              ? "info"
              : n.status === "failed"
                ? "danger"
                : "off")
        }
      />
      <span className="strong">{label ?? n.subagent ?? n.sessionId}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
      <Node n={node} root label={title ?? node.subagent ?? "root session"} />
      {node.children.length > 0 && (
        <>
          <div className="dim mono" style={{ alignSelf: "center" }}>
            ──┐
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {node.children.map((c) => (
              <div key={c.sessionId} className="row gap-2">
                <span className="dim mono" style={{ fontSize: 10 }}>
                  └─
                </span>
                <Node n={c} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Small inline `×` affordance used to dismiss a pending question/approval
// from the Overview without answering. Sized to nestle into a card header
// next to the timestamp.
function DismissButton({
  title,
  onClick,
}: {
  title: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        padding: 0,
        border: "1px solid transparent",
        borderRadius: 3,
        background: "transparent",
        color: "var(--fg-muted)",
        cursor: "pointer",
        lineHeight: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-soft)";
        e.currentTarget.style.color = "var(--fg)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.color = "var(--fg-muted)";
      }}
    >
      <Icon name="x" size={11} />
    </button>
  );
}

// ── Needs you ───────────────────────────────────────────────────────────────

interface NeedsYouProps {
  questions: QuestionRecord[];
  approvals: ApprovalRecord[];
  onOpenSession: (id: string) => void;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
  onDecide: (approvalId: string, decision: "approve" | "deny") => void;
  onDismissQuestion: (questionId: string) => void;
  onDismissApproval: (approvalId: string) => void;
}

function NeedsYou({
  questions,
  approvals,
  onOpenSession,
  onAnswer,
  onDecide,
  onDismissQuestion,
  onDismissApproval,
}: NeedsYouProps): JSX.Element {
  const branding = useBranding();
  const total = questions.length + approvals.length;
  return (
    <Card title={`needs ${branding.userName}`} accent badge={<span className="tag accent">{total}</span>}>
      {total === 0 && (
        <div className="hint" style={{ padding: "8px 0" }}>
          inbox zero — no pending questions or approvals.
        </div>
      )}
      {questions.map((q) => (
        <NeedsYouQuestion
          key={q.id}
          question={q}
          onAnswer={onAnswer}
          onOpenSession={onOpenSession}
          onDismiss={onDismissQuestion}
        />
      ))}
      {approvals.map((a) => (
        <div key={a.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border-soft)" }}>
          <div className="row gap-2" style={{ marginBottom: 4 }}>
            <Icon name="lock" size={12} style={{ color: "var(--warn)" }} />
            <span className="strong">approval</span>
            {a.tags[0] && <span className="tag warn">{a.tags[0]}</span>}
            <span className="spacer" />
            <span className="hint">{fmtAgo(a.createdAt)}</span>
            <DismissButton
              title="dismiss this approval"
              onClick={() => onDismissApproval(a.id)}
            />
          </div>
          <div className="mono" style={{ fontSize: "var(--t-sm)", marginBottom: 6 }}>
            <span className="muted">$ </span>
            {a.toolName}
          </div>
          <div className="row gap-2">
            <button className="btn primary sm" onClick={() => onDecide(a.id, "approve")}>
              approve
            </button>
            <button className="btn sm" onClick={() => onDecide(a.id, "deny")}>
              deny
            </button>
            <span className="spacer" />
            <span
              className="link"
              onClick={() => onOpenSession(a.sessionId)}
              style={{ fontSize: "var(--t-xs)" }}
            >
              {a.sessionId.slice(-8)} ↗
            </span>
          </div>
        </div>
      ))}
      {total > 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          clear queue with <span className="kbd">A</span> · skip <span className="kbd">S</span>
        </div>
      )}
    </Card>
  );
}

/**
 * Inbox-style row for a pending question on the Overview. Shows every
 * sub-question with its options + an always-available freeform "other"
 * input, then submits all answers in one click. The Chat view has a
 * fancier inline version of the same control — both go through the same
 * onAnswer(questionId, answers: Record<string, string>) path.
 */
function NeedsYouQuestion({
  question,
  onAnswer,
  onOpenSession,
  onDismiss,
}: {
  question: QuestionRecord;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
  onOpenSession: (id: string) => void;
  onDismiss: (questionId: string) => void;
}): JSX.Element | null {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const subQs = question.input.questions;
  if (subQs.length === 0) return null;
  const allFilled = subQs.every((sq) => {
    const v = picks[sq.question];
    return typeof v === "string" && v.trim().length > 0;
  });
  const submit = (): void => {
    if (!allFilled) return;
    const answers: Record<string, string> = {};
    for (const sq of subQs) answers[sq.question] = picks[sq.question]!.trim();
    onAnswer(question.id, answers);
  };
  return (
    <div style={{ borderBottom: "1px solid var(--border-soft)", padding: "8px 0" }}>
      <div className="row gap-2" style={{ marginBottom: 4 }}>
        <Icon name="ask" size={12} className="strong" />
        <span className="strong">
          question{subQs.length > 1 ? `s · ${subQs.length}` : ""}
        </span>
        <span className="faint mono" style={{ fontSize: "var(--t-xs)" }}>
          {question.id.slice(-8)}
        </span>
        <span className="spacer" />
        <span className="hint">{fmtAgo(question.askedAt)}</span>
        <DismissButton
          title="dismiss this question"
          onClick={() => onDismiss(question.id)}
        />
      </div>
      {subQs.map((sq, qi) => {
        const picked = picks[sq.question];
        const showOther = otherOpen[sq.question] ?? false;
        return (
          <div key={`${sq.question}-${qi}`} style={{ marginTop: qi === 0 ? 0 : 10 }}>
            <div
              style={{
                fontFamily: "var(--font-ui)",
                fontSize: "var(--t-md)",
                color: "var(--fg)",
                marginBottom: 6,
              }}
            >
              {subQs.length > 1 && (
                <span className="faint" style={{ marginRight: 6 }}>
                  Q{qi + 1}.
                </span>
              )}
              {sq.question}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {sq.options.map((o, i) => {
                const active = picked === o.label;
                return (
                  <div
                    key={o.label}
                    className="row gap-2"
                    onClick={() => {
                      setPicks((p) => ({ ...p, [sq.question]: o.label }));
                      setOtherOpen((s) => ({ ...s, [sq.question]: false }));
                    }}
                    style={{
                      padding: "5px 8px",
                      border:
                        "1px solid " +
                        (active ? "var(--accent)" : "var(--border-soft)"),
                      borderRadius: 3,
                      background: active ? "var(--accent-soft)" : "var(--bg-inset)",
                      cursor: "pointer",
                      fontSize: "var(--t-sm)",
                    }}
                  >
                    <span className="bracket faint">
                      {String.fromCharCode(97 + i)}
                    </span>
                    <span>{o.label}</span>
                    {o.description && (
                      <>
                        <span className="spacer" />
                        <span className="hint">{o.description}</span>
                      </>
                    )}
                  </div>
                );
              })}
              <div
                className="row gap-2"
                onClick={() =>
                  setOtherOpen((s) => ({ ...s, [sq.question]: !showOther }))
                }
                style={{
                  padding: "5px 8px",
                  border:
                    "1px solid " +
                    (showOther ? "var(--accent)" : "var(--border-soft)"),
                  borderRadius: 3,
                  background: showOther ? "var(--accent-soft)" : "var(--bg-inset)",
                  cursor: "pointer",
                  fontSize: "var(--t-sm)",
                }}
              >
                <span className="bracket faint">o</span>
                <span>Other…</span>
                <span className="spacer" />
                <span className="hint">type a freeform answer</span>
              </div>
              {showOther && (
                <input
                  autoFocus
                  className="input"
                  placeholder="type your answer"
                  value={
                    sq.options.some((o) => o.label === picked) ? "" : picked ?? ""
                  }
                  onChange={(e) =>
                    setPicks((p) => ({ ...p, [sq.question]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && allFilled) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  style={{ marginTop: 4, width: "100%" }}
                />
              )}
            </div>
          </div>
        );
      })}
      <div className="row gap-2" style={{ marginTop: 6 }}>
        <button
          className="btn primary sm"
          disabled={!allFilled}
          onClick={submit}
        >
          {subQs.length > 1 ? "send answers" : "send answer"}
        </button>
        <span className="spacer" />
        <span className="link" onClick={() => onOpenSession(question.sessionId)}>
          open session ↗
        </span>
      </div>
    </div>
  );
}

// ── Recent activity ─────────────────────────────────────────────────────────

function RecentActivity({
  activity,
  onOpenSession,
}: {
  activity: ActivityItem[];
  onOpenSession: (id: string) => void;
}): JSX.Element {
  const colorFor = (k: string): string =>
    k.startsWith("approval") ? "var(--warn)"
      : k.startsWith("question") ? "var(--accent)"
        : k.startsWith("task") ? "var(--ok)"
          : k.startsWith("subagent") ? "var(--info)"
            : "var(--fg-muted)";
  return (
    <Card
      title="recent activity"
      badge={<span className="tag">live feed</span>}
      actions={<span className="hint">{activity.length} events</span>}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {activity.length === 0 && (
          <div className="hint" style={{ padding: "8px 0" }}>
            waiting for events…
          </div>
        )}
        {activity.slice(0, 12).map((e) => (
          <div
            key={e.id}
            className="row gap-2"
            style={{ padding: "5px 0", borderBottom: "1px solid var(--border-soft)" }}
          >
            <span
              className="mono faint"
              style={{ width: 60, fontSize: "var(--t-xs)", flexShrink: 0 }}
            >
              {fmtAgo(e.at)}
            </span>
            <span style={{ width: 14, flexShrink: 0, color: colorFor(e.kind) }}>
              <Icon name={e.icon as IconName} size={12} />
            </span>
            <span
              className="mono faint"
              style={{ width: 120, flexShrink: 0, fontSize: "var(--t-xs)" }}
            >
              {e.kind}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: "var(--t-sm)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {e.text}
            </span>
            {e.sessionId && (
              <span
                className="mono link"
                style={{ fontSize: "var(--t-xs)" }}
                onClick={() => onOpenSession(e.sessionId!)}
              >
                {e.sessionId.slice(-6)}
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Shared task list ────────────────────────────────────────────────────────

function SharedTaskList({
  tasks,
  sessions,
  setView,
}: {
  tasks: Task[];
  sessions: SessionRecord[];
  setView: (v: ViewId) => void;
}): JSX.Element {
  const open = tasks.filter((t) => t.status !== "completed" && t.status !== "deleted");
  const top = useMemo(() => {
    const ip = tasks.filter((t) => t.status === "in_progress");
    if (ip.length >= 6) return ip.slice(0, 6);
    return [...ip, ...tasks.filter((t) => t.status === "pending")].slice(0, 6);
  }, [tasks]);

  const sessionOf = (taskListId: string): string => {
    // taskListId is derived from the session-tree root id.
    return sessions.find((s) => s.id === taskListId)?.title ?? taskListId.slice(-6);
  };

  return (
    <Card
      title="shared task list"
      badge={<span className="tag">{open.length} open</span>}
      actions={
        <span className="link" onClick={() => setView("tasks")} style={{ fontSize: "var(--t-xs)" }}>
          kanban ↗
        </span>
      }
    >
      <div className="row-list">
        {top.length === 0 && <div className="hint">no open tasks</div>}
        {top.map((t) => {
          const meta = t.metadata ?? {};
          const progress = typeof meta.progress === "number" ? meta.progress : null;
          return (
            <div key={t.id} className="row gap-2" style={{ padding: "6px 0" }}>
              <span className="faint mono" style={{ width: 48, fontSize: "var(--t-xs)" }}>
                {t.id.slice(-5)}
              </span>
              <span style={{ flex: 1, fontSize: "var(--t-sm)" }}>{t.subject}</span>
              <div style={{ width: 64 }}>
                <div className="bar">
                  <span style={{ width: (progress != null ? progress * 100 : t.status === "in_progress" ? 50 : 0) + "%" }} />
                </div>
              </div>
              <span
                className={
                  "tag " + (t.owner === "subagent" ? "info" : t.owner === "user" ? "warn" : "")
                }
              >
                {t.owner ?? "unowned"}
              </span>
              <span
                className="mono faint"
                style={{ fontSize: "var(--t-xs)", width: 80, textAlign: "right" }}
              >
                {sessionOf(t.taskListId).slice(-12)}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Plugin widgets row ──────────────────────────────────────────────────────

function PluginWidgetsSection({ plugins }: { plugins: PluginRecord[] }): JSX.Element | null {
  // Only render if at least one enabled plugin claimed the overviewWidget
  // slot — otherwise we'd be rendering generic placeholders for plugins
  // that never asked to appear here.
  const widgets = plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.uiContributions
        .filter((c) => c.slot === "overviewWidget")
        .map((c) => ({ plugin: p, contribution: c })),
    );
  if (widgets.length === 0) return null;
  return (
    <div style={{ padding: "0 16px 16px" }}>
      <div className="row gap-2" style={{ marginBottom: 8 }}>
        <span className="section-label">plugin widgets</span>
        <span className="ascii-rule">────────────────────────────────────────────────</span>
        <span className="hint">
          {widgets.length} contributed by {new Set(widgets.map((w) => w.plugin.id)).size} plugin{widgets.length === 1 ? "" : "s"}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(3, widgets.length)}, 1fr)`,
          gap: 12,
        }}
      >
        {widgets.slice(0, 6).map((w) => (
          <Card
            key={w.plugin.id + ":" + w.contribution.id}
            title={"plugin · " + w.contribution.label}
            badge={<span className="tag">{w.plugin.kinds[0] ?? "ext"}</span>}
          >
            <div className="hint" style={{ marginBottom: 6 }}>
              {w.plugin.name} · v{w.plugin.version}
            </div>
            <div className="hint">
              renders here when the plugin SDK ships an iframe-isolated UI surface.
            </div>
            <div className="row gap-2" style={{ marginTop: 8 }}>
              <span className="chip">{modelFamily(w.plugin.id)}</span>
              <span className="chip on">overviewWidget</span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
