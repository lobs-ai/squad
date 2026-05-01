import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ApprovalRecord,
  MessageRecord,
  QuestionRecord,
  SessionRecord,
  Task,
} from "@squad/protocol";
import { Icon } from "../ui/Icon.js";
import { Markdown } from "../ui/Markdown.js";
import {
  useBranding,
  useGateway,
  type LiveToolEvent,
  type SubagentTreeNode,
} from "../state/GatewayContext.js";
import { estimateCost, fmtAgo, fmtCost, fmtTokens, modelShort } from "../state/fmt.js";
import { usePersistedState } from "../state/usePersistedState.js";

type Drawer = "tasks" | "discord" | "inspector" | null;

interface ChatRowMessage {
  kind:
    | "user"
    | "assistant"
    | "tool_use"
    | "tool_result"
    | "system"
    | "question"
    | "approval";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolIsError?: boolean;
  questionId?: string;
  approvalId?: string;
  at: string;
  model?: string | null;
  streaming?: boolean;
}

export function Chat(): JSX.Element {
  const {
    activeSession,
    rootSession,
    sessions,
    treeSessions,
    messages,
    liveTools,
    streaming,
    awaitingResponse,
    tasks,
    subagentTree,
    pendingQuestions,
    sessionQuestions,
    sessionApprovals,
    setActiveSessionId,
    sendChat,
    startSession,
    renameSession,
    setSessionModel,
    answerQuestion,
    decideApproval,
    allowApprovalPath,
    models,
    chatError,
    clearChatError,
  } = useGateway();
  const branding = useBranding();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [pickingModel, setPickingModel] = useState(false);
  // Persisted across reloads so the user's preference sticks. Defaults to "on"
  // — same as the CLI, which always shows tool calls inline.
  const [showToolsRaw, setShowToolsRaw] = usePersistedState("squad-chat-show-tools", "1");
  const showTools = showToolsRaw !== "0";
  const toggleShowTools = (): void => setShowToolsRaw(showTools ? "0" : "1");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Escape collapses whatever transient surface is open, in priority order.
  // Stops at the first one so a user pressing esc with no drawer/edit/etc.
  // open doesn't accidentally clear the composer they were just typing in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (pickingModel) {
        e.preventDefault();
        setPickingModel(false);
        return;
      }
      if (editingTitle) {
        e.preventDefault();
        setEditingTitle(false);
        return;
      }
      if (drawer) {
        e.preventDefault();
        setDrawer(null);
        return;
      }
      if (chatError) {
        e.preventDefault();
        clearChatError();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickingModel, editingTitle, drawer, chatError, clearChatError]);

  // Auto-scroll the transcript when new content arrives. Only scrolls when
  // already near the bottom so a user reading history isn't yanked away.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming, awaitingResponse]);

  if (!activeSession) {
    return (
      <div style={{ padding: 32 }}>
        <div className="hint">no active session — pick one in the sidebar or start a new one.</div>
      </div>
    );
  }

  const isSubagent = !!activeSession.parentSessionId;
  // Use the full session-question list (any status) so answered + cancelled
  // questions stay in the transcript instead of vanishing the moment the
  // user clicks an option. Pending ones still drive the typing indicator
  // suppression below via pendingForSession.
  const sessQuestions = sessionQuestions;
  const pendingForSession = pendingQuestions.filter((q) => q.sessionId === activeSession.id);
  // Use the full session-approval list (any status) so decided approvals
  // stay in the transcript with their "approved" / "denied" status instead
  // of disappearing the moment the user clicks a button.
  const sessApprovals = sessionApprovals;
  const cost = estimateCost(activeSession.model, activeSession.tokensIn, activeSession.tokensOut);

  const rows = buildRows(messages, streaming, sessQuestions, sessApprovals, liveTools, showTools);

  const submit = async (): Promise<void> => {
    if (!composer.trim() || sending) return;
    setSending(true);
    try {
      await sendChat(composer);
      setComposer("");
    } catch {
      // sendChat already pushed the error into chatError; keep the
      // composer text so the user can edit + retry.
    } finally {
      setSending(false);
    }
  };

  const treeNode = subagentTree;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        gridTemplateRows: "1fr",
        height: "100%",
        minHeight: 0,
        position: "relative",
      }}
    >
      {/* tree column */}
      <div
        style={{
          borderRight: "1px solid var(--border)",
          background: "var(--bg-elevated)",
          overflow: "auto",
          padding: "10px 0",
        }}
      >
        <div className="side-section">
          <div className="section-label">session tree</div>
        </div>
        {treeNode && (
          <SessionTreeView
            node={treeNode}
            depth={0}
            sessions={sessions}
            activeId={activeSession.id}
            onPick={setActiveSessionId}
          />
        )}
        {!treeNode && (
          <div style={{ padding: "0 12px" }}>
            <div className="side-item active" style={{ paddingLeft: 12 }}>
              <span className={"dot " + (activeSession.status === "running" ? "ok pulse" : "off")} />
              <span className="lbl">{activeSession.title ?? activeSession.id}</span>
            </div>
            {treeSessions
              .filter((s) => s.id !== activeSession.id)
              .map((s) => (
                <div
                  key={s.id}
                  className="side-item"
                  onClick={() => setActiveSessionId(s.id)}
                  style={{ paddingLeft: 24 }}
                >
                  <span className="dim mono" style={{ fontSize: 10 }}>
                    └─
                  </span>
                  <span className="lbl">{s.title ?? s.id}</span>
                </div>
              ))}
          </div>
        )}
        <div className="side-section" style={{ marginTop: 14 }}>
          <div className="section-label">scope</div>
        </div>
        <div style={{ padding: "0 12px", fontSize: "var(--t-sm)" }} className="col gap-1">
          <KV k="model" v={modelShort(activeSession.model)} />
          <KV k="status" v={activeSession.status} />
          <KV k="platform" v={activeSession.platform ?? "—"} />
          <KV k="tokens in" v={fmtTokens(activeSession.tokensIn)} />
          <KV k="tokens out" v={fmtTokens(activeSession.tokensOut)} />
          <KV k="est. cost" v={fmtCost(cost)} />
          {cost != null && (
            <div className="bar" style={{ marginTop: 4 }}>
              <span style={{ width: Math.min(100, (cost / 2) * 100) + "%" }} />
            </div>
          )}
        </div>
      </div>

      {/* main column */}
      <div className="col" style={{ minHeight: 0 }}>
        <div className="row gap-3" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <span className={"dot " + (activeSession.status === "running" ? "ok pulse" : "off")} />
          {isSubagent && <span className="tag info">subagent</span>}
          {editingTitle ? (
            <input
              className="input"
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditingTitle(false);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const next = titleDraft.trim();
                  if (next && next !== activeSession.title) {
                    void renameSession(activeSession.id, next);
                  }
                  setEditingTitle(false);
                }
              }}
              style={{ maxWidth: 360 }}
            />
          ) : (
            <span
              className="strong"
              style={{ fontSize: "var(--t-md)", cursor: "text" }}
              title="click to rename"
              onClick={() => {
                setTitleDraft(activeSession.title ?? "");
                setEditingTitle(true);
              }}
            >
              {activeSession.title ?? "(untitled · click to name)"}
            </span>
          )}
          <span className="tag">{activeSession.id.slice(-8)}</span>
          <ModelSwapButton
            session={activeSession}
            models={models}
            open={pickingModel}
            onToggle={() => setPickingModel((o) => !o)}
            onPick={(m) => {
              void setSessionModel(activeSession.id, m);
              setPickingModel(false);
            }}
          />
          {activeSession.platform && <span className="tag info">{activeSession.platform}</span>}
          {isSubagent && rootSession && (
            <span className="hint">
              ↑ parent{" "}
              <span
                className="mono link"
                onClick={() => setActiveSessionId(rootSession.id)}
              >
                {rootSession.id.slice(-8)}
              </span>
            </span>
          )}
          <span className="spacer" />
          <span className="hint">started {fmtAgo(activeSession.createdAt)}</span>
          <div className="row gap-1">
            <button
              className="btn sm"
              onClick={() => void startSession({})}
              title="Start a new chat session (⌘N)"
            >
              <Icon name="plus" size={11} /> new
            </button>
            <button
              className={"btn sm " + (showTools ? "primary" : "")}
              onClick={toggleShowTools}
              title={
                showTools
                  ? "tool calls visible in transcript — click to hide"
                  : "tool calls hidden — click to show"
              }
            >
              <Icon name="term" size={11} /> tools{" "}
              <span className="faint">{showTools ? "on" : "off"}</span>
            </button>
            <button
              className={"btn sm " + (drawer === "tasks" ? "primary" : "")}
              onClick={() => setDrawer(drawer === "tasks" ? null : "tasks")}
            >
              <Icon name="tasks" size={11} /> tasks <span className="faint">{tasks.length}</span>
            </button>
            <button
              className={"btn sm " + (drawer === "discord" ? "primary" : "")}
              onClick={() => setDrawer(drawer === "discord" ? null : "discord")}
            >
              <Icon name="discord" size={11} /> channel
            </button>
            <button
              className={"btn sm " + (drawer === "inspector" ? "primary" : "")}
              onClick={() => setDrawer(drawer === "inspector" ? null : "inspector")}
            >
              <Icon name="search" size={11} /> inspector
            </button>
          </div>
        </div>
        <div ref={transcriptRef} className="grow" style={{ overflow: "auto", padding: "16px 24px" }}>
          {chatError && (
            <div
              style={{
                marginBottom: 16,
                padding: 10,
                borderRadius: 4,
                border: "1px solid color-mix(in oklab, var(--danger) 45%, var(--border))",
                background: "color-mix(in oklab, var(--danger) 8%, var(--bg))",
                fontSize: "var(--t-sm)",
              }}
            >
              <div className="row gap-2" style={{ marginBottom: 4 }}>
                <Icon name="warn" size={12} style={{ color: "var(--danger)" }} />
                <span className="strong" style={{ color: "var(--danger)" }}>
                  agent error
                </span>
                <span className="hint">{fmtAgo(chatError.at)}</span>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={clearChatError} title="dismiss (esc)">
                  <Icon name="x" size={11} />
                </button>
              </div>
              <div className="mono" style={{ color: "var(--fg-muted)", whiteSpace: "pre-wrap" }}>
                {chatError.message}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                check that <span className="kbd">{activeSession.model}</span> is reachable. for custom providers,
                make sure the api key + endpoint are configured in the gateway.
              </div>
            </div>
          )}
          {rows.length === 0 && !chatError && (
            <div className="hint">empty session — start by typing a message below.</div>
          )}
          {rows.map((r, i) => (
            <ChatRow
              key={i}
              row={r}
              question={r.questionId ? sessQuestions.find((q) => q.id === r.questionId) : undefined}
              approval={r.approvalId ? sessApprovals.find((a) => a.id === r.approvalId) : undefined}
              onAnswer={(qid, answers) => void answerQuestion(qid, answers)}
              onDecide={(aid, dec) => void decideApproval(aid, dec)}
              onAlwaysAllow={(aid) => void allowApprovalPath(aid)}
            />
          ))}
          {awaitingResponse && !streaming && pendingForSession.length === 0 && <TypingIndicator />}
        </div>
        <div style={{ borderTop: "1px solid var(--border)", padding: 10, background: "var(--bg-elevated)" }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              padding: "8px 10px",
            }}
          >
            <textarea
              className="input"
              placeholder="reply or pick an option above…"
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              style={{ background: "transparent", border: 0, padding: 0, minHeight: 36 }}
              disabled={sending}
            />
            <div className="row gap-2" style={{ marginTop: 6 }}>
              <span className="hint">⌘↵ to send</span>
              <span className="spacer" />
              <button type="submit" className="btn primary sm" disabled={sending || !composer.trim()}>
                {sending ? "sending…" : "send"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* slide-over drawer */}
      {drawer && (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 320,
            borderLeft: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            display: "flex",
            flexDirection: "column",
            boxShadow: "var(--shadow-2)",
            zIndex: 5,
          }}
        >
          <div
            className="row gap-2"
            style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}
          >
            <span className="section-label">{drawer}</span>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setDrawer(null)}>
              <Icon name="x" size={11} />
            </button>
          </div>
          <div className="grow" style={{ overflow: "auto", padding: 12 }}>
            {drawer === "tasks" && <SessionTasksPanel tasks={tasks} />}
            {drawer === "discord" && <ChannelPanel session={activeSession} />}
            {drawer === "inspector" && <InspectorPanel session={activeSession} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSwapButton({
  session,
  models,
  open,
  onToggle,
  onPick,
}: {
  session: { model: string };
  models: Array<{ id: string; displayName: string; provider: string; notes?: string }>;
  open: boolean;
  onToggle: () => void;
  onPick: (model: string) => void;
}): JSX.Element {
  return (
    <span style={{ position: "relative" }}>
      <button
        className="tag"
        onClick={onToggle}
        title="change model — applies on the next turn"
        style={{ cursor: "pointer" }}
      >
        {modelShort(session.model)}
        <Icon name="chevron-down" size={9} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            width: 320,
            maxHeight: "55vh",
            overflow: "auto",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-2)",
            zIndex: 30,
          }}
        >
          {groupByProvider(models).map(([provider, list]) => (
            <div key={provider}>
              <div
                style={{
                  padding: "6px 10px",
                  fontSize: "var(--t-xs)",
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  color: "var(--fg-faint)",
                  background: "var(--bg-inset)",
                }}
              >
                {provider}
              </div>
              {list.map((m) => (
                <div
                  key={m.id}
                  className="row gap-2"
                  onClick={() => onPick(m.id)}
                  style={{
                    padding: "6px 10px",
                    cursor: "pointer",
                    background: m.id === session.model ? "var(--bg-hover)" : undefined,
                    fontSize: "var(--t-sm)",
                  }}
                >
                  <span style={{ flex: 1 }}>{m.displayName}</span>
                  {m.notes && <span className="hint">{m.notes}</span>}
                </div>
              ))}
            </div>
          ))}
          {models.length === 0 && (
            <div className="hint" style={{ padding: 12 }}>
              no models — wire a provider in <span className="kbd">api keys</span>.
            </div>
          )}
        </div>
      )}
    </span>
  );
}

function groupByProvider<T extends { provider: string }>(models: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const m of models) {
    const arr = groups.get(m.provider) ?? [];
    arr.push(m);
    groups.set(m.provider, arr);
  }
  return Array.from(groups.entries());
}

function KV({ k, v }: { k: string; v: ReactNode }): JSX.Element {
  return (
    <div className="row gap-2">
      <span className="faint">{k}</span>
      <span className="spacer" />
      <span>{v}</span>
    </div>
  );
}

// ── Session tree (recursive) ───────────────────────────────────────────────

function SessionTreeView({
  node,
  depth,
  activeId,
  sessions,
  onPick,
}: {
  node: SubagentTreeNode;
  depth: number;
  activeId: string;
  sessions: SessionRecord[];
  onPick: (id: string) => void;
}): JSX.Element {
  const cur = activeId === node.sessionId;
  const sess = sessions.find((s) => s.id === node.sessionId);
  const label = sess?.title ?? node.subagent ?? node.sessionId.slice(-8);
  const model = sess?.model ?? "";
  return (
    <>
      <div
        className="side-item"
        onClick={() => onPick(node.sessionId)}
        style={{
          paddingLeft: 10 + depth * 12,
          background: cur ? "var(--bg)" : undefined,
          color: cur ? "var(--fg-strong)" : undefined,
          borderLeftColor: cur ? "var(--accent)" : undefined,
        }}
      >
        {depth > 0 && (
          <span className="dim mono" style={{ fontSize: 10 }}>
            └─
          </span>
        )}
        <span
          className={
            "dot " +
            (node.status === "running"
              ? "ok pulse"
              : node.status === "completed"
                ? "info"
                : node.status === "failed"
                  ? "danger"
                  : "off")
          }
        />
        <span className="lbl">{label}</span>
        {model && <span className="meta">{modelShort(model).split("-")[0]}</span>}
      </div>
      {node.children.map((c) => (
        <SessionTreeView
          key={c.sessionId}
          node={c}
          depth={depth + 1}
          activeId={activeId}
          sessions={sessions}
          onPick={onPick}
        />
      ))}
    </>
  );
}

// ── Build typed transcript rows from raw messages + pending Q/A ────────────

function buildRows(
  messages: MessageRecord[],
  streaming: string,
  questions: QuestionRecord[],
  approvals: ApprovalRecord[],
  liveTools: LiveToolEvent[],
  showTools: boolean,
): ChatRowMessage[] {
  const rows: ChatRowMessage[] = [];
  // Tool-use ids we've already emitted from persisted assistant messages.
  // Live broadcast events for the same call are skipped so we don't render
  // it twice when the final assistant_message lands at end-of-run.
  const seenToolUseIds = new Set<string>();
  for (const m of messages) {
    const at = m.createdAt;
    if (m.role === "user") {
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      rows.push({ kind: "user", text, at });
    } else if (m.role === "assistant") {
      // Assistant turns can interleave text with tool_use blocks. Emit them
      // in order so the transcript reads chronologically inside the turn.
      let chunk = "";
      for (const b of m.content) {
        if (b.type === "text") chunk += (chunk ? "\n\n" : "") + b.text;
        else if (b.type === "tool_use") {
          if (chunk) {
            rows.push({ kind: "assistant", text: chunk, at });
            chunk = "";
          }
          if (showTools) {
            rows.push({
              kind: "tool_use",
              toolName: b.name,
              toolInput: b.input,
              at,
            });
          }
          seenToolUseIds.add(b.id);
        }
      }
      if (chunk) rows.push({ kind: "assistant", text: chunk, at });
    } else if (m.role === "tool") {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          if (showTools) {
            rows.push({
              kind: "tool_result",
              toolResult: b.content,
              toolIsError: b.isError,
              at,
            });
          }
          seenToolUseIds.add(b.toolUseId);
        }
      }
    } else if (m.role === "system") {
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) rows.push({ kind: "system", text, at });
    }
  }
  if (streaming) {
    rows.push({ kind: "assistant", text: streaming, at: new Date().toISOString(), streaming: true });
  }
  if (showTools) {
    for (const ev of liveTools) {
      if (seenToolUseIds.has(ev.toolCallId)) continue;
      if (ev.kind === "call") {
        rows.push({
          kind: "tool_use",
          toolName: ev.name,
          toolInput: ev.input,
          at: ev.at,
        });
      } else {
        rows.push({
          kind: "tool_result",
          toolResult: ev.result,
          toolIsError: ev.isError,
          at: ev.at,
        });
      }
    }
  }
  for (const q of questions) {
    rows.push({ kind: "question", questionId: q.id, at: q.askedAt });
  }
  for (const a of approvals) {
    rows.push({ kind: "approval", approvalId: a.id, at: a.createdAt });
  }
  // Stable chronological sort. Messages already came in order; questions and
  // approvals get spliced in by timestamp.
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return rows;
}

// ── Transcript row renderer ─────────────────────────────────────────────────

function ChatRow({
  row,
  question,
  approval,
  onAnswer,
  onDecide,
  onAlwaysAllow,
}: {
  row: ChatRowMessage;
  question?: QuestionRecord;
  approval?: ApprovalRecord;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
  onDecide: (approvalId: string, decision: "approve" | "deny") => void;
  onAlwaysAllow: (approvalId: string) => void;
}): JSX.Element | null {
  const branding = useBranding();
  if (row.kind === "user") {
    return (
      <div style={{ marginBottom: 16 }}>
        <div className="row gap-2" style={{ marginBottom: 4 }}>
          <Icon name="user" size={12} />
          <span className="strong">{branding.userName}</span>
          <span className="hint">{fmtAgo(row.at)}</span>
        </div>
        <Markdown text={row.text ?? ""} />
      </div>
    );
  }
  if (row.kind === "assistant") {
    return (
      <div style={{ marginBottom: 16 }}>
        <div className="row gap-2" style={{ marginBottom: 4 }}>
          <Icon name="bot" size={12} style={{ color: "var(--accent)" }} />
          <span className="strong">{branding.agentName}</span>
          <span className="hint">{fmtAgo(row.at)}</span>
          {row.streaming && <span className="tag accent">streaming</span>}
        </div>
        <div style={{ position: "relative" }}>
          <Markdown text={row.text ?? ""} />
          {row.streaming && <span className="cursor" />}
        </div>
      </div>
    );
  }
  if (row.kind === "tool_use") {
    const target = formatToolTarget(row.toolInput);
    return (
      <div
        style={{
          marginBottom: 12,
          border: "1px solid var(--border-soft)",
          borderRadius: 4,
          background: "var(--bg-inset)",
          overflow: "hidden",
        }}
      >
        <div
          className="row gap-2"
          style={{
            padding: "5px 10px",
            background: "var(--bg-card)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: "var(--t-xs)",
          }}
        >
          <Icon name="term" size={11} />
          <span className="strong mono">{row.toolName}</span>
          {target && <span className="faint mono">→ {target}</span>}
          <span className="spacer" />
          <span className="tag">tool call</span>
          <span className="hint">{fmtAgo(row.at)}</span>
        </div>
      </div>
    );
  }
  if (row.kind === "tool_result") {
    const out = formatToolResult(row.toolResult);
    return (
      <div
        style={{
          marginBottom: 12,
          border: "1px solid var(--border-soft)",
          borderRadius: 4,
          background: "var(--bg-inset)",
          overflow: "hidden",
        }}
      >
        <div
          className="row gap-2"
          style={{
            padding: "5px 10px",
            background: "var(--bg-card)",
            borderBottom: "1px solid var(--border-soft)",
            fontSize: "var(--t-xs)",
          }}
        >
          <Icon name="term" size={11} />
          <span className="strong mono">tool result</span>
          <span className="spacer" />
          <span className={"tag " + (row.toolIsError ? "danger" : "ok")}>{row.toolIsError ? "error" : "ok"}</span>
          <span className="hint">{fmtAgo(row.at)}</span>
        </div>
        {out && (
          <div
            className="mono"
            style={{
              padding: "6px 10px",
              fontSize: "var(--t-xs)",
              color: "var(--fg-muted)",
              maxHeight: 200,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {out}
          </div>
        )}
      </div>
    );
  }
  if (row.kind === "system") {
    return (
      <div className="row gap-2" style={{ marginBottom: 6, fontSize: "var(--t-sm)", color: "var(--fg-faint)" }}>
        <Icon name="circle" size={11} />
        <span style={{ fontStyle: "italic" }}>{row.text}</span>
      </div>
    );
  }
  if (row.kind === "question" && question) {
    return <QuestionCard question={question} onAnswer={onAnswer} />;
  }
  if (row.kind === "approval" && approval) {
    const isPending = approval.status === "pending";
    const accent = isPending
      ? "var(--warn)"
      : approval.status === "approved"
        ? "var(--ok)"
        : "var(--danger)";
    return (
      <div
        style={{
          marginBottom: 14,
          border: `1px solid color-mix(in oklab, ${accent} 35%, var(--border))`,
          borderRadius: 4,
          padding: 10,
          background: `color-mix(in oklab, ${accent} 6%, var(--bg))`,
          opacity: isPending ? 1 : 0.92,
        }}
      >
        <div className="row gap-2" style={{ marginBottom: 4 }}>
          <Icon
            name={isPending ? "lock" : approval.status === "approved" ? "check" : "x"}
            size={12}
            style={{ color: accent }}
          />
          <span className="strong">
            {isPending ? "approval required" : approval.status}
          </span>
          {approval.tags[0] && (
            <span className={"tag " + (isPending ? "warn" : approval.status === "approved" ? "ok" : "danger")}>
              {approval.tags[0]}
            </span>
          )}
          <span className="spacer" />
          <span className="hint">
            {fmtAgo(isPending ? approval.createdAt : approval.decidedAt ?? approval.createdAt)}
          </span>
        </div>
        <div className="mono" style={{ fontSize: "var(--t-sm)", marginBottom: isPending ? 6 : 0 }}>
          <span className="muted">$ </span>
          {approval.toolName} <span className="faint">→</span>{" "}
          <span className="strong">{formatToolTarget(approval.input) ?? "(no target)"}</span>
        </div>
        {isPending && (
          <div className="row gap-2">
            <button className="btn primary sm" onClick={() => onDecide(approval.id, "approve")}>
              approve
            </button>
            <button className="btn sm" onClick={() => onDecide(approval.id, "deny")}>
              deny
            </button>
            <button className="btn ghost sm" onClick={() => onAlwaysAllow(approval.id)}>
              always allow this path
            </button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

/**
 * One ask_user record may carry up to 4 sub-questions. We render every
 * sub-question with its own option grid and a free-text "other" input so
 * the user picks an answer for each, then submits them all at once. After
 * the record is no longer pending we keep the card around in the
 * transcript and show the chosen answers inline so the conversation reads
 * coherently on reload.
 */
function QuestionCard({
  question,
  onAnswer,
}: {
  question: QuestionRecord;
  onAnswer: (questionId: string, answers: Record<string, string>) => void;
}): JSX.Element | null {
  const [picks, setPicks] = useState<Record<string, string>>({});
  // Tracks which sub-questions have the freeform "other" input revealed.
  // Indexed by sub-question text so identical labels in the same record
  // (rare but legal) don't collide.
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const subQs = question.input.questions;
  if (subQs.length === 0) return null;
  const isPending = question.status === "pending";

  const allFilled = subQs.every((sq) => {
    const v = picks[sq.question];
    return typeof v === "string" && v.trim().length > 0;
  });

  const submit = (): void => {
    if (!allFilled || submitting) return;
    setSubmitting(true);
    const answers: Record<string, string> = {};
    for (const sq of subQs) answers[sq.question] = picks[sq.question]!.trim();
    onAnswer(question.id, answers);
  };

  return (
    <div
      style={{
        marginBottom: 14,
        border: "1px solid var(--accent-line)",
        borderRadius: 4,
        background: "var(--accent-soft)",
        padding: 12,
        opacity: isPending ? 1 : 0.92,
      }}
    >
      <div className="row gap-2" style={{ marginBottom: 6 }}>
        <Icon name="ask" size={12} style={{ color: "var(--accent)" }} />
        <span className="strong">
          question{subQs.length > 1 ? `s · ${subQs.length}` : ""} · {question.id.slice(-8)}
        </span>
        {!isPending && (
          <span className={"tag " + (question.status === "answered" ? "ok" : "warn")}>
            {question.status}
          </span>
        )}
        <span className="spacer" />
        <span className="hint">{fmtAgo(question.askedAt)}</span>
      </div>
      {subQs.map((sq, qi) => {
        const recorded = question.answers?.[sq.question];
        const picked = picks[sq.question];
        const showOther = otherOpen[sq.question] ?? false;
        return (
          <div key={`${sq.question}-${qi}`} style={{ marginTop: qi === 0 ? 0 : 12 }}>
            <div
              style={{
                fontFamily: "var(--font-ui)",
                fontSize: "var(--t-md)",
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
            {!isPending ? (
              <div
                className="row gap-2"
                style={{
                  fontSize: "var(--t-sm)",
                  padding: "6px 8px",
                  border: "1px solid var(--border-soft)",
                  borderRadius: 3,
                  background: "var(--bg-inset)",
                }}
              >
                <Icon name="check" size={11} style={{ color: "var(--ok)" }} />
                <span className="strong">{recorded ?? "(no answer)"}</span>
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {sq.options.map((o, i) => {
                    const active = picked === o.label;
                    return (
                      <button
                        key={o.label}
                        className={"btn " + (active ? "primary" : "")}
                        onClick={() => {
                          setPicks((p) => ({ ...p, [sq.question]: o.label }));
                          setOtherOpen((s) => ({ ...s, [sq.question]: false }));
                        }}
                        style={{ justifyContent: "flex-start", textAlign: "left" }}
                        title={o.description}
                      >
                        <span className="bracket faint">
                          {String.fromCharCode(97 + i)}
                        </span>
                        <span style={{ textAlign: "left" }}>{o.label}</span>
                      </button>
                    );
                  })}
                  <button
                    className={"btn " + (showOther ? "primary" : "")}
                    onClick={() =>
                      setOtherOpen((s) => ({ ...s, [sq.question]: !showOther }))
                    }
                    style={{ justifyContent: "flex-start", textAlign: "left" }}
                    title="type a freeform answer"
                  >
                    <span className="bracket faint">o</span>
                    <span style={{ textAlign: "left" }}>Other…</span>
                  </button>
                </div>
                {showOther && (
                  <input
                    autoFocus
                    className="input"
                    placeholder="type your answer"
                    value={
                      // If the current pick came from a static option, don't
                      // pre-fill the freeform box with it — that would be
                      // confusing. Only echo back picks the user typed here.
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
                    style={{ marginTop: 6, width: "100%" }}
                  />
                )}
              </>
            )}
          </div>
        );
      })}
      {isPending && (
        <div className="row gap-2" style={{ marginTop: 10 }}>
          <span className="hint">
            {allFilled
              ? "ready to send"
              : `pick ${subQs.length - subQs.filter((sq) => picks[sq.question]?.trim()).length} more`}
          </span>
          <span className="spacer" />
          <button
            className="btn primary sm"
            disabled={!allFilled || submitting}
            onClick={submit}
          >
            {submitting ? "sending…" : subQs.length > 1 ? "send answers" : "send answer"}
          </button>
        </div>
      )}
    </div>
  );
}

function TypingIndicator(): JSX.Element {
  const branding = useBranding();
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row gap-2" style={{ marginBottom: 4 }}>
        <Icon name="bot" size={12} style={{ color: "var(--accent)" }} />
        <span className="strong">{branding.agentName}</span>
        <span className="hint">thinking…</span>
      </div>
      <div className="typing-dots" aria-label={`${branding.agentName} is typing`}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function formatToolTarget(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target", "cmd", "command", "url", "query"]) {
    const v = i[key];
    if (typeof v === "string") return v.length > 80 ? v.slice(0, 78) + "…" : v;
  }
  return null;
}

function formatToolResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result.length > 800 ? result.slice(0, 800) + "…" : result;
  try {
    const s = JSON.stringify(result, null, 2);
    return s.length > 800 ? s.slice(0, 800) + "…" : s;
  } catch {
    return null;
  }
}

// ── Drawer panels ──────────────────────────────────────────────────────────

function SessionTasksPanel({ tasks }: { tasks: Task[] }): JSX.Element {
  if (tasks.length === 0) return <div className="hint">no tasks in this session tree.</div>;
  return (
    <div className="col gap-2">
      <div className="section-label">in this session tree</div>
      {tasks.map((t) => (
        <div
          key={t.id}
          className="row gap-2"
          style={{
            fontSize: "var(--t-sm)",
            padding: "5px 6px",
            borderRadius: 3,
            background: "var(--bg-card)",
            border: "1px solid var(--border-soft)",
          }}
        >
          <span
            className={
              "dot " +
              (t.status === "completed"
                ? "ok"
                : t.status === "in_progress"
                  ? "accent pulse"
                  : t.status === "deleted"
                    ? "off"
                    : "off")
            }
          />
          <span className="faint mono" style={{ width: 36, fontSize: 10 }}>
            {t.id.slice(-4)}
          </span>
          <span
            style={{
              flex: 1,
              color: t.status === "completed" ? "var(--fg-faint)" : undefined,
              textDecoration: t.status === "completed" ? "line-through" : undefined,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.subject}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChannelPanel({ session }: { session: SessionRecord }): JSX.Element {
  return (
    <div className="col gap-2">
      <div className="section-label">channel · {session.platform ?? "—"}</div>
      <div className="card" style={{ padding: 10 }}>
        <div className="row gap-2" style={{ marginBottom: 6 }}>
          <Icon name="discord" size={12} style={{ color: "var(--accent)" }} />
          <span className="strong">{session.platform ?? "no channel"}</span>
        </div>
        {session.remoteId ? (
          <>
            <div className="hint">
              remote id <span className="mono">{session.remoteId}</span>
            </div>
            <div className="hint">
              session bound at <span className="mono">{fmtAgo(session.createdAt)}</span>
            </div>
          </>
        ) : (
          <div className="hint">unbound — direct dashboard session.</div>
        )}
      </div>
      <button className="btn sm" disabled={!session.platform}>
        jump to channel ↗
      </button>
    </div>
  );
}

function InspectorPanel({ session }: { session: SessionRecord }): JSX.Element {
  const cost = estimateCost(session.model, session.tokensIn, session.tokensOut);
  return (
    <div className="col gap-2">
      <div className="section-label">raw session</div>
      <div
        className="mono"
        style={{
          fontSize: "var(--t-xs)",
          color: "var(--fg-muted)",
          whiteSpace: "pre",
          background: "var(--bg-inset)",
          padding: 10,
          borderRadius: 3,
        }}
      >
        {[
          ["session.id", session.id],
          ["session.parent", session.parentSessionId ?? "null"],
          ["model", session.model],
          ["fallbacks", session.fallbacks.join(", ") || "—"],
          ["status", session.status],
          ["delivery", session.deliveryMode],
          ["tokens.in", session.tokensIn.toLocaleString()],
          ["tokens.out", session.tokensOut.toLocaleString()],
          ["est. cost", fmtCost(cost)],
          ["created", session.createdAt],
          ["updated", session.updatedAt],
        ]
          .map(([k, v]) => k.padEnd(18) + " " + v)
          .join("\n")}
      </div>
    </div>
  );
}
