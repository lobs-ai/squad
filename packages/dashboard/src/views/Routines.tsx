import { useEffect, useMemo, useState } from "react";
import type {
  Execution,
  Payload,
  RoutineRecord,
  RoutineRunLog,
  Schedule,
  SessionTarget,
} from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway, type UpdateRoutinePatch } from "../state/GatewayContext.js";
import { fmtAgo } from "../state/fmt.js";

type DeliveryDraft = RoutineRecord["delivery"];

const SAMPLE_CRONS: Array<{ label: string; cron: string }> = [
  { label: "every minute", cron: "* * * * *" },
  { label: "hourly", cron: "0 * * * *" },
  { label: "daily 9am", cron: "0 9 * * *" },
  { label: "weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "every 15m", cron: "*/15 * * * *" },
];

const INTERVAL_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "every 1m", ms: 60_000 },
  { label: "every 5m", ms: 5 * 60_000 },
  { label: "every 15m", ms: 15 * 60_000 },
  { label: "every 1h", ms: 60 * 60_000 },
  { label: "every 6h", ms: 6 * 60 * 60_000 },
  { label: "every 24h", ms: 24 * 60 * 60_000 },
];

export function Routines(): JSX.Element {
  const {
    routines,
    models,
    config,
    sessions,
    createRoutine,
    updateRoutine,
    deleteRoutine,
    runRoutine,
    fetchRoutineRuns,
  } = useGateway();
  const [creating, setCreating] = useState(false);
  const defaultModel = config?.primary.model ?? "";
  const sessionOptions = useMemo(
    () => sessions.map((s) => ({ id: s.id, label: s.title || `session ${s.id.slice(0, 6)}` })),
    [sessions],
  );

  return (
    <div>
      <PageHead
        title="cron jobs"
        crumbs="scheduled prompts, scripts, and agent turns"
        actions={
          <div className="row gap-2">
            <button className="btn sm primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={11} /> new cron job
            </button>
          </div>
        }
      />
      <div style={{ padding: 16, display: "grid", gap: 12 }}>
        {creating && (
          <CronForm
            models={models}
            defaultModel={defaultModel}
            sessionOptions={sessionOptions}
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              await createRoutine(input);
              setCreating(false);
            }}
          />
        )}

        <Card title="all jobs" badge={<span className="tag">{routines.length}</span>}>
          {routines.length === 0 && (
            <div className="hint">
              no cron jobs yet — schedule your first with{" "}
              <span className="link" onClick={() => setCreating(true)}>+ new cron job</span>.
            </div>
          )}
          <div className="row-list">
            {routines.map((r) => (
              <CronRow
                key={r.id}
                routine={r}
                models={models}
                sessionOptions={sessionOptions}
                onUpdate={(patch) => void updateRoutine(r.id, patch)}
                onDelete={() => void deleteRoutine(r.id)}
                onRun={async () => {
                  await runRoutine(r.id);
                }}
                fetchRuns={fetchRoutineRuns}
              />
            ))}
          </div>
        </Card>

        <div className="hint">
          schedule kinds: <span className="kbd">cron</span> · <span className="kbd">interval</span> · <span className="kbd">once</span>{" "}
          · payload kinds: <span className="kbd">prompt</span> · <span className="kbd">script</span> · <span className="kbd">agentTurn</span>
        </div>
      </div>
    </div>
  );
}

// ── Row + collapsible details ──────────────────────────────────────────────

function CronRow({
  routine,
  models,
  sessionOptions,
  onUpdate,
  onDelete,
  onRun,
  fetchRuns,
}: {
  routine: RoutineRecord;
  models: Array<{ id: string; displayName: string; provider: string }>;
  sessionOptions: Array<{ id: string; label: string }>;
  onUpdate: (patch: UpdateRoutinePatch) => void;
  onDelete: () => void;
  onRun: () => Promise<void>;
  fetchRuns: (
    id: string,
    opts?: { limit?: number; status?: "ok" | "error" | "skipped" },
  ) => Promise<RoutineRunLog[]>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [running, setRunning] = useState(false);

  const scheduleLabel = describeSchedule(routine.schedule);
  const payloadLabel = describePayload(routine.payload);
  const sessionLabel = describeSessionTarget(routine.session);
  const statusBadge = lastStatusBadge(routine);

  return (
    <div style={{ padding: "10px 0" }}>
      <div
        className="row gap-3"
        style={{
          fontSize: "var(--t-sm)",
          flexWrap: "wrap",
          cursor: "pointer",
          alignItems: "center",
        }}
        onClick={(e) => {
          // Don't toggle when clicking inside one of the action buttons.
          const target = e.target as HTMLElement;
          if (target.closest("button")) return;
          setEditing((v) => !v);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing((v) => !v);
          }
        }}
        title={editing ? "click to close editor" : "click to edit"}
      >
        <span className={"dot " + (routine.enabled ? "ok pulse" : "off")} />
        <span className="strong" style={{ minWidth: 140 }}>
          {routine.name}
        </span>
        <span className="mono faint" style={{ width: 160 }} title={scheduleLabel.full}>
          {scheduleLabel.short}
        </span>
        <span className="tag" title={payloadLabel.full}>
          {payloadLabel.short}
        </span>
        <span className="tag" title={sessionLabel.full}>
          {sessionLabel.short}
        </span>
        <span className="tag">{routine.delivery.kind}</span>
        <span className="mono faint" style={{ width: 130, fontSize: "var(--t-xs)" }}>
          {routine.execution.model ?? routine.model ?? "(default)"}
        </span>
        {statusBadge}
        <span className="hint" style={{ minWidth: 100 }}>
          last {fmtAgo(routine.lastRunAt)}
        </span>
        <span className="hint" style={{ minWidth: 100 }}>
          next {fmtNext(routine.nextRunAt)}
        </span>
        <span className="spacer" />
        <button
          className="btn ghost sm"
          onClick={(e) => {
            e.stopPropagation();
            onUpdate({ enabled: !routine.enabled });
          }}
        >
          {routine.enabled ? "disable" : "enable"}
        </button>
        <button
          className="btn ghost sm"
          onClick={async (e) => {
            e.stopPropagation();
            if (running) return;
            setRunning(true);
            try {
              await onRun();
            } finally {
              setRunning(false);
            }
          }}
          disabled={running}
        >
          {running ? "running…" : "run now"}
        </button>
        <button
          className="btn ghost sm"
          onClick={(e) => {
            e.stopPropagation();
            setShowRuns((s) => !s);
          }}
        >
          {showRuns ? "hide history" : "history"}
        </button>
        <button
          className="btn ghost sm danger"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          delete
        </button>
        <span className="hint" style={{ marginLeft: 4 }}>
          {editing ? "▾" : "▸"}
        </span>
      </div>
      {routine.lastError && (
        <div className="hint" style={{ marginTop: 4, color: "var(--danger)" }}>
          last error: {routine.lastError}
        </div>
      )}
      {showRuns && <RunHistory routine={routine} fetchRuns={fetchRuns} />}
      {editing && (
        <div style={{ marginTop: 8, paddingLeft: 16, borderLeft: "2px solid var(--accent-line)" }}>
          <CronForm
            initial={routine}
            models={models}
            defaultModel={routine.execution.model ?? routine.model ?? ""}
            sessionOptions={sessionOptions}
            onCancel={() => setEditing(false)}
            onSubmit={async (patch) => {
              onUpdate({
                name: patch.name,
                enabled: patch.enabled,
                schedule: patch.schedule,
                payload: patch.payload,
                session: patch.session,
                execution: patch.execution,
                delivery: patch.delivery,
              });
              setEditing(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Run history panel ──────────────────────────────────────────────────────

function RunHistory({
  routine,
  fetchRuns,
}: {
  routine: RoutineRecord;
  fetchRuns: (
    id: string,
    opts?: { limit?: number; status?: "ok" | "error" | "skipped" },
  ) => Promise<RoutineRunLog[]>;
}): JSX.Element {
  const [runs, setRuns] = useState<RoutineRunLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRuns(routine.id, { limit: 20 })
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routine.id, routine.lastRunAt, fetchRuns]);

  return (
    <div
      style={{
        marginTop: 8,
        paddingLeft: 16,
        borderLeft: "2px solid var(--accent-line)",
        display: "grid",
        gap: 6,
      }}
    >
      <div className="section-label row gap-2">
        <span>recent runs</span>
        {loading && <span className="hint">loading…</span>}
      </div>
      {error && (
        <div className="hint" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}
      {!loading && !error && runs.length === 0 && (
        <div className="hint">no runs yet — try "run now" to fire one.</div>
      )}
      {runs.map((r, i) => (
        <RunRow key={r.ts + ":" + i} run={r} />
      ))}
    </div>
  );
}

function RunRow({ run }: { run: RoutineRunLog }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ts = new Date(run.ts).toLocaleString();
  const tone =
    run.status === "ok" ? "ok" : run.status === "error" ? "danger" : "faint";
  return (
    <div style={{ fontSize: "var(--t-xs)" }}>
      <div className="row gap-3" style={{ alignItems: "center" }}>
        <span className={"tag " + tone}>{run.status}</span>
        <span className="mono">{ts}</span>
        <span className="hint">{run.durationMs}ms</span>
        <span className="hint">{run.payloadKind}</span>
        {run.tokens && (
          <span className="hint">
            {run.tokens.in}↦{run.tokens.out}
          </span>
        )}
        {run.sessionId && (
          <span className="mono faint" title={run.sessionId}>
            session {run.sessionId.slice(0, 8)}
          </span>
        )}
        <span className="spacer" />
        {(run.output || run.error) && (
          <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>
            {open ? "hide" : "details"}
          </button>
        )}
      </div>
      {open && (
        <pre
          className="mono"
          style={{
            background: "var(--bg-sunken)",
            padding: 8,
            marginTop: 4,
            maxHeight: 240,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            fontSize: "var(--t-xs)",
          }}
        >
          {run.error ?? run.output ?? "(no output)"}
        </pre>
      )}
    </div>
  );
}

// ── Form (handles all schedule + payload + session shapes) ────────────────

interface StructuredFormSubmit {
  name: string;
  enabled: boolean;
  schedule: Schedule;
  payload: Payload;
  session: SessionTarget;
  execution: Execution;
  delivery: DeliveryDraft;
}

interface FormProps {
  initial?: RoutineRecord;
  models: Array<{ id: string; displayName: string; provider: string }>;
  defaultModel: string;
  sessionOptions: Array<{ id: string; label: string }>;
  onCancel: () => void;
  onSubmit: (input: StructuredFormSubmit) => Promise<void>;
}

type ScheduleKind = Schedule["kind"];
type PayloadKind = Payload["kind"];
type SessionKind = SessionTarget["kind"];

function CronForm({
  initial,
  models,
  defaultModel,
  sessionOptions,
  onCancel,
  onSubmit,
}: FormProps): JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");

  // Schedule fields — the form keeps state for each kind so toggling
  // doesn't lose what the user typed.
  const initialKind: ScheduleKind = initial?.schedule.kind ?? "cron";
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(initialKind);
  const [cronExpr, setCronExpr] = useState(
    initial?.schedule.kind === "cron" ? initial.schedule.expr : "0 9 * * *",
  );
  const [intervalMs, setIntervalMs] = useState(
    initial?.schedule.kind === "interval" ? initial.schedule.everyMs : 30 * 60_000,
  );
  const [onceAt, setOnceAt] = useState(
    initial?.schedule.kind === "once" ? initial.schedule.at : isoLocalNowPlus(60),
  );

  // Payload fields — same idea, one slot per kind.
  const initialPayloadKind: PayloadKind = initial?.payload.kind ?? "prompt";
  const [payloadKind, setPayloadKind] = useState<PayloadKind>(initialPayloadKind);
  const [promptText, setPromptText] = useState(
    initial?.payload.kind === "prompt" ? initial.payload.text : initial?.prompt ?? "",
  );
  const [skillsCsv, setSkillsCsv] = useState(
    initial?.payload.kind === "prompt" && initial.payload.skills
      ? initial.payload.skills.join(", ")
      : "",
  );
  const [scriptCommand, setScriptCommand] = useState(
    initial?.payload.kind === "script" ? initial.payload.command : "",
  );
  const [scriptArgsCsv, setScriptArgsCsv] = useState(
    initial?.payload.kind === "script" && initial.payload.args
      ? initial.payload.args.join(" ")
      : "",
  );
  const [scriptCwd, setScriptCwd] = useState(
    initial?.payload.kind === "script" ? initial.payload.cwd ?? "" : "",
  );
  const [agentTurnText, setAgentTurnText] = useState(
    initial?.payload.kind === "agentTurn"
      ? initial.payload.messages.find((m) => m.role === "user")?.text ?? ""
      : "",
  );
  const [agentTurnSystem, setAgentTurnSystem] = useState(
    initial?.payload.kind === "agentTurn"
      ? initial.payload.messages.find((m) => m.role === "system")?.text ?? ""
      : "",
  );

  // Session targeting.
  const initialSessionKind: SessionKind = initial?.session.kind ?? "new";
  const [sessionKind, setSessionKind] = useState<SessionKind>(initialSessionKind);
  const [sessionId, setSessionId] = useState(
    initial?.session.kind === "session" ? initial.session.sessionId : "",
  );

  // Per-job execution overrides.
  const [model, setModel] = useState(
    initial?.execution.model ?? initial?.model ?? defaultModel,
  );
  const [toolsAllowCsv, setToolsAllowCsv] = useState(
    initial?.execution.toolsAllow ? initial.execution.toolsAllow.join(", ") : "",
  );
  const [timeoutSec, setTimeoutSec] = useState<number | "">(
    initial?.execution.timeoutSec ?? "",
  );

  const [delivery, setDelivery] = useState<DeliveryDraft>(
    initial?.delivery ?? { kind: "dashboard" },
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Build the structured payload from the form ─────────────────────────
  const schedule: Schedule | null = useMemo(() => {
    if (scheduleKind === "cron") {
      const expr = cronExpr.trim();
      if (expr.split(/\s+/).length !== 5) return null;
      return { kind: "cron", expr };
    }
    if (scheduleKind === "interval") {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
      return { kind: "interval", everyMs: intervalMs };
    }
    const at = new Date(onceAt);
    if (Number.isNaN(at.getTime())) return null;
    return { kind: "once", at: at.toISOString() };
  }, [scheduleKind, cronExpr, intervalMs, onceAt]);

  const payload: Payload | null = useMemo(() => {
    if (payloadKind === "prompt") {
      const text = promptText.trim();
      if (!text) return null;
      const skills = skillsCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { kind: "prompt", text, ...(skills.length > 0 ? { skills } : {}) };
    }
    if (payloadKind === "script") {
      const command = scriptCommand.trim();
      if (!command) return null;
      const args = scriptArgsCsv.trim()
        ? scriptArgsCsv.trim().split(/\s+/)
        : undefined;
      const cwd = scriptCwd.trim() || undefined;
      return {
        kind: "script",
        command,
        ...(args ? { args } : {}),
        ...(cwd ? { cwd } : {}),
      };
    }
    const messages: Array<{ role: "user" | "system"; text: string }> = [];
    if (agentTurnSystem.trim())
      messages.push({ role: "system", text: agentTurnSystem.trim() });
    if (agentTurnText.trim())
      messages.push({ role: "user", text: agentTurnText.trim() });
    if (messages.length === 0) return null;
    return { kind: "agentTurn", messages };
  }, [
    payloadKind,
    promptText,
    skillsCsv,
    scriptCommand,
    scriptArgsCsv,
    scriptCwd,
    agentTurnText,
    agentTurnSystem,
  ]);

  const session: SessionTarget = useMemo(() => {
    if (sessionKind === "session") {
      return { kind: "session", sessionId };
    }
    return { kind: sessionKind };
  }, [sessionKind, sessionId]);

  const execution: Execution = useMemo(() => {
    const out: Execution = {};
    if (model) out.model = model;
    const toolsAllow = toolsAllowCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (toolsAllow.length > 0) out.toolsAllow = toolsAllow;
    if (typeof timeoutSec === "number" && timeoutSec > 0) out.timeoutSec = timeoutSec;
    return out;
  }, [model, toolsAllowCsv, timeoutSec]);

  const valid =
    name.trim() !== "" &&
    schedule !== null &&
    payload !== null &&
    (sessionKind !== "session" || sessionId.trim() !== "");

  const submit = async (): Promise<void> => {
    if (!valid || !schedule || !payload) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        enabled,
        schedule,
        payload,
        session,
        execution,
        delivery,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={initial ? "edit cron job" : "new cron job"}>
      <div className="col gap-3">
        {/* Identity */}
        <div className="row gap-3">
          <div style={{ flex: 1 }}>
            <div className="section-label">name</div>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="morning-summary"
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="section-label">enabled</div>
            <select
              className="input"
              value={enabled ? "1" : "0"}
              onChange={(e) => setEnabled(e.target.value === "1")}
            >
              <option value="1">yes — fires on schedule</option>
              <option value="0">paused</option>
            </select>
          </div>
        </div>

        {/* Schedule */}
        <div>
          <div className="section-label">schedule</div>
          <KindTabs
            options={[
              { value: "cron", label: "cron" },
              { value: "interval", label: "interval" },
              { value: "once", label: "once" },
            ]}
            value={scheduleKind}
            onChange={setScheduleKind}
          />
          {scheduleKind === "cron" && (
            <div style={{ marginTop: 6 }}>
              <input
                className="input mono"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="m h dom mon dow"
              />
              <div className="row gap-1" style={{ marginTop: 4, flexWrap: "wrap" }}>
                {SAMPLE_CRONS.map((s) => (
                  <span
                    key={s.label}
                    className="chip"
                    style={{ cursor: "pointer" }}
                    onClick={() => setCronExpr(s.cron)}
                    title={s.cron}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
              <div className="hint">
                <span className="kbd">m h dom mon dow</span> · star = any · `*/N` = every N · `1-5` = weekdays
              </div>
            </div>
          )}
          {scheduleKind === "interval" && (
            <div style={{ marginTop: 6 }}>
              <div className="row gap-2">
                <input
                  type="number"
                  className="input"
                  style={{ width: 140 }}
                  value={intervalMs}
                  min={1000}
                  step={1000}
                  onChange={(e) => setIntervalMs(Number(e.target.value))}
                />
                <span className="hint">milliseconds (≈ {fmtMs(intervalMs)})</span>
              </div>
              <div className="row gap-1" style={{ marginTop: 4, flexWrap: "wrap" }}>
                {INTERVAL_PRESETS.map((p) => (
                  <span
                    key={p.label}
                    className="chip"
                    style={{ cursor: "pointer" }}
                    onClick={() => setIntervalMs(p.ms)}
                  >
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          {scheduleKind === "once" && (
            <div style={{ marginTop: 6 }}>
              <input
                type="datetime-local"
                className="input mono"
                value={onceAt}
                onChange={(e) => setOnceAt(e.target.value)}
              />
              <div className="hint">fires once, then the job auto-disables.</div>
            </div>
          )}
        </div>

        {/* Payload */}
        <div>
          <div className="section-label">what to run</div>
          <KindTabs
            options={[
              { value: "prompt", label: "prompt (LLM)" },
              { value: "script", label: "script (no LLM)" },
              { value: "agentTurn", label: "agent turn" },
            ]}
            value={payloadKind}
            onChange={setPayloadKind}
          />
          {payloadKind === "prompt" && (
            <div className="col gap-2" style={{ marginTop: 6 }}>
              <textarea
                className="input"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                placeholder="summarize yesterday's tasks…"
                style={{ minHeight: 80 }}
              />
              <div>
                <div className="section-label">skills (comma-separated)</div>
                <input
                  className="input"
                  value={skillsCsv}
                  onChange={(e) => setSkillsCsv(e.target.value)}
                  placeholder="weather, news"
                />
              </div>
            </div>
          )}
          {payloadKind === "script" && (
            <div className="col gap-2" style={{ marginTop: 6 }}>
              <div className="row gap-2">
                <div style={{ flex: 1 }}>
                  <div className="section-label">command</div>
                  <input
                    className="input mono"
                    value={scriptCommand}
                    onChange={(e) => setScriptCommand(e.target.value)}
                    placeholder="curl"
                  />
                </div>
                <div style={{ flex: 2 }}>
                  <div className="section-label">args (space-separated)</div>
                  <input
                    className="input mono"
                    value={scriptArgsCsv}
                    onChange={(e) => setScriptArgsCsv(e.target.value)}
                    placeholder="-fsSL https://example.com"
                  />
                </div>
              </div>
              <div>
                <div className="section-label">cwd (optional)</div>
                <input
                  className="input mono"
                  value={scriptCwd}
                  onChange={(e) => setScriptCwd(e.target.value)}
                  placeholder="/path/to/wd"
                />
              </div>
              <div className="hint">
                no LLM, no session — just a child process. tip: print "[SILENT]" on the first line to skip delivery.
              </div>
            </div>
          )}
          {payloadKind === "agentTurn" && (
            <div className="col gap-2" style={{ marginTop: 6 }}>
              <div>
                <div className="section-label">system message (optional)</div>
                <textarea
                  className="input"
                  value={agentTurnSystem}
                  onChange={(e) => setAgentTurnSystem(e.target.value)}
                  placeholder="you are a brevity-first analyst…"
                  style={{ minHeight: 60 }}
                />
              </div>
              <div>
                <div className="section-label">user message</div>
                <textarea
                  className="input"
                  value={agentTurnText}
                  onChange={(e) => setAgentTurnText(e.target.value)}
                  placeholder="what's the latest?"
                  style={{ minHeight: 60 }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Session target */}
        <div>
          <div className="section-label">session target</div>
          <KindTabs
            options={[
              { value: "new", label: "new (default)" },
              { value: "isolated", label: "isolated" },
              { value: "session", label: "specific" },
            ]}
            value={sessionKind}
            onChange={setSessionKind}
          />
          {sessionKind === "session" && (
            <div style={{ marginTop: 6 }}>
              <select
                className="input"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">— choose a session —</option>
                {sessionOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="hint">
            {sessionKind === "new" && "fresh session per fire — visible in the dashboard."}
            {sessionKind === "isolated" && "fresh session that doesn't appear in the sessions list."}
            {sessionKind === "session" && "appends a user turn to the chosen session."}
          </div>
        </div>

        {/* Execution overrides */}
        {payloadKind !== "script" && (
          <div className="row gap-3">
            <div style={{ flex: 1 }}>
              <div className="section-label">model</div>
              <select
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">(gateway default)</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div className="section-label">tools allowed (comma-separated)</div>
              <input
                className="input mono"
                value={toolsAllowCsv}
                onChange={(e) => setToolsAllowCsv(e.target.value)}
                placeholder="(empty = all)"
              />
            </div>
            <div style={{ width: 120 }}>
              <div className="section-label">timeout (s)</div>
              <input
                type="number"
                className="input"
                value={timeoutSec === "" ? "" : timeoutSec}
                onChange={(e) =>
                  setTimeoutSec(e.target.value === "" ? "" : Number(e.target.value))
                }
                placeholder="300"
              />
            </div>
          </div>
        )}

        {/* Delivery */}
        <div className="row gap-3">
          <div style={{ flex: 1 }}>
            <div className="section-label">delivery</div>
            <select
              className="input"
              value={delivery.kind}
              onChange={(e) => {
                const k = e.target.value as DeliveryDraft["kind"];
                if (k === "discord") {
                  setDelivery({ kind: "discord", channelId: "" });
                } else {
                  setDelivery({ kind: k });
                }
              }}
            >
              <option value="dashboard">dashboard (open in chat)</option>
              <option value="silent">silent (background only)</option>
              <option value="discord">discord (post to a channel)</option>
            </select>
          </div>
        </div>
        {delivery.kind === "discord" && (
          <div className="row gap-3">
            <div style={{ flex: 1 }}>
              <div className="section-label">discord channel id</div>
              <input
                className="input mono"
                value={delivery.channelId}
                onChange={(e) => setDelivery({ ...delivery, channelId: e.target.value })}
                placeholder="123456789012345678"
              />
            </div>
            <div style={{ flex: 1 }}>
              <div className="section-label">guild id (optional)</div>
              <input
                className="input mono"
                value={delivery.guildId ?? ""}
                onChange={(e) =>
                  setDelivery({ ...delivery, ...(e.target.value ? { guildId: e.target.value } : {}) })
                }
                placeholder="(optional)"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="hint" style={{ color: "var(--danger)" }}>
            {error}
          </div>
        )}
        <div className="row gap-2">
          <span className="hint">
            {valid ? "ready" : "fill name + valid schedule + payload" + (sessionKind === "session" ? " + session" : "")}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? "saving…" : initial ? "save changes" : "create cron job"}
          </button>
        </div>
      </div>
    </Card>
  );
}

// ── Tiny presentational helpers ────────────────────────────────────────────

function KindTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="row gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          className={"btn sm " + (o.value === value ? "primary" : "ghost")}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function describeSchedule(s: Schedule): { short: string; full: string } {
  if (s.kind === "cron") return { short: s.expr, full: `cron ${s.expr}` };
  if (s.kind === "interval") {
    const label = fmtMs(s.everyMs);
    return { short: `every ${label}`, full: `interval ${s.everyMs}ms` };
  }
  return { short: `at ${new Date(s.at).toLocaleString()}`, full: `once @ ${s.at}` };
}

function describePayload(p: Payload): { short: string; full: string } {
  if (p.kind === "prompt") {
    return { short: "prompt", full: p.text.slice(0, 200) };
  }
  if (p.kind === "script") {
    const cmd = [p.command, ...(p.args ?? [])].join(" ");
    return { short: "script", full: cmd.slice(0, 200) };
  }
  return { short: "agentTurn", full: `${p.messages.length} messages` };
}

function describeSessionTarget(t: SessionTarget): { short: string; full: string } {
  if (t.kind === "new") return { short: "new", full: "new session per fire" };
  if (t.kind === "isolated") return { short: "isolated", full: "isolated session" };
  return { short: "session", full: `session ${t.sessionId.slice(0, 8)}` };
}

function lastStatusBadge(r: RoutineRecord): JSX.Element | null {
  if (!r.lastStatus) return null;
  const tone =
    r.lastStatus === "ok"
      ? "ok"
      : r.lastStatus === "error"
      ? "danger"
      : "faint";
  return <span className={"tag " + tone}>{r.lastStatus}</span>;
}

function fmtNext(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  if (diff <= 0) return "now";
  if (diff < 60_000) return `in ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function isoLocalNowPlus(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  // datetime-local needs YYYY-MM-DDTHH:MM (no seconds, no Z)
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}
