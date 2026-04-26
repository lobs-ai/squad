import { Icon } from "../ui/Icon.js";
import type { ViewId } from "../views/views.js";
import { useGateway } from "../state/GatewayContext.js";
import { estimateCost, fmtAgo, fmtCost, fmtTokens } from "../state/fmt.js";

interface Props {
  setView: (v: ViewId) => void;
}

export function StatusBar({ setView }: Props): JSX.Element {
  const { squad, sessions, tasks, pendingQuestions, pendingApprovals, activeSession } = useGateway();
  const pending = pendingQuestions.length + pendingApprovals.length;
  const subagents = sessions.filter((s) => s.parentSessionId).length;
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress").length;

  // Cost shown in the status bar tracks the active session — the same number
  // you see in the chat header — so the user can keep tabs on per-run spend
  // without leaving whatever view they're in.
  const cost = activeSession ? estimateCost(activeSession.model, activeSession.tokensIn, activeSession.tokensOut) : 0;
  const tokens = activeSession ? activeSession.tokensIn + activeSession.tokensOut : 0;

  return (
    <div className="statusbar">
      <div className="seg">
        <span className={"dot " + (squad?.status === "healthy" ? "ok pulse" : "off")} />
        <span className="strong">{squad?.name ?? "—"}</span>
        <span className="muted">·</span>
        <span>:{squad?.port ?? "—"}</span>
      </div>
      <div className="seg muted">v{squad?.version ?? "—"}</div>
      {squad?.build && <div className="seg muted">build {squad.build}</div>}
      <div className="seg muted">started {squad?.startedAt ? fmtAgo(squad.startedAt) : "—"}</div>
      <div className="spacer" />
      <div className="seg click" onClick={() => setView("overview")}>
        <Icon name="bot" size={11} />
        <span>
          {subagents} subagent{subagents === 1 ? "" : "s"}
        </span>
      </div>
      <div className="seg click" onClick={() => setView("tasks")}>
        <Icon name="tasks" size={11} />
        <span>{inProgressTasks} tasks</span>
      </div>
      <div
        className="seg click"
        onClick={() => setView("overview")}
        style={{ color: pending > 0 ? "var(--accent)" : undefined }}
      >
        <Icon name="bell" size={11} />
        <span>{pending} pending</span>
      </div>
      <div className="seg muted">
        tok {fmtTokens(tokens)} · {fmtCost(cost)}
      </div>
    </div>
  );
}
