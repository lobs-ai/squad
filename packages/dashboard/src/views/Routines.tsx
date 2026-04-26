import { useState } from "react";
import type { RoutineRecord } from "@squad/protocol";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import { fmtAgo } from "../state/fmt.js";

type DeliveryDraft = RoutineRecord["delivery"];

const SAMPLE_CRONS: Array<{ label: string; cron: string }> = [
  { label: "every minute", cron: "* * * * *" },
  { label: "hourly", cron: "0 * * * *" },
  { label: "daily 9am", cron: "0 9 * * *" },
  { label: "weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "every 15m", cron: "*/15 * * * *" },
];

export function Routines(): JSX.Element {
  const {
    routines,
    models,
    config,
    createRoutine,
    updateRoutine,
    deleteRoutine,
    runRoutine,
  } = useGateway();
  const [creating, setCreating] = useState(false);
  const defaultModel = config?.primary.model ?? "";

  return (
    <div>
      <PageHead
        title="routines"
        crumbs="cron-scheduled prompts"
        actions={
          <div className="row gap-2">
            <button className="btn sm primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={11} /> new routine
            </button>
          </div>
        }
      />
      <div style={{ padding: 16, display: "grid", gap: 12 }}>
        {creating && (
          <RoutineForm
            models={models}
            defaultModel={defaultModel}
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              await createRoutine(input);
              setCreating(false);
            }}
          />
        )}

        <Card title="all routines" badge={<span className="tag">{routines.length}</span>}>
          {routines.length === 0 && (
            <div className="hint">
              no routines yet — schedule a recurring prompt with{" "}
              <span className="link" onClick={() => setCreating(true)}>+ new routine</span>.
            </div>
          )}
          <div className="row-list">
            {routines.map((r) => (
              <RoutineRow
                key={r.id}
                routine={r}
                models={models}
                onUpdate={(patch) => void updateRoutine(r.id, patch)}
                onDelete={() => void deleteRoutine(r.id)}
                onRun={async () => {
                  await runRoutine(r.id);
                }}
              />
            ))}
          </div>
        </Card>

        <div className="hint">
          cron syntax: <span className="kbd">m h dom mon dow</span> · star = any · `*/N` = every N · `1-5` = weekdays.
        </div>
      </div>
    </div>
  );
}

function RoutineRow({
  routine,
  models,
  onUpdate,
  onDelete,
  onRun,
}: {
  routine: RoutineRecord;
  models: Array<{ id: string; displayName: string; provider: string }>;
  onUpdate: (patch: Partial<RoutineRecord>) => void;
  onDelete: () => void;
  onRun: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);

  return (
    <div style={{ padding: "10px 0" }}>
      <div className="row gap-3" style={{ fontSize: "var(--t-sm)" }}>
        <span className={"dot " + (routine.enabled ? "ok pulse" : "off")} />
        <span className="strong" style={{ minWidth: 140 }}>
          {routine.name}
        </span>
        <span className="mono faint" style={{ width: 130 }}>
          {routine.cron}
        </span>
        <span style={{ width: 200, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {routine.prompt}
        </span>
        <span className="tag">{routine.delivery.kind}</span>
        <span className="mono faint" style={{ width: 140, fontSize: "var(--t-xs)" }}>
          {routine.model ?? "(default)"}
        </span>
        <span className="hint" style={{ width: 100 }}>
          last run {fmtAgo(routine.lastRunAt)}
        </span>
        <span className="spacer" />
        <button
          className="btn ghost sm"
          onClick={() => onUpdate({ enabled: !routine.enabled })}
        >
          {routine.enabled ? "disable" : "enable"}
        </button>
        <button
          className="btn ghost sm"
          onClick={async () => {
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
        <button className="btn ghost sm" onClick={() => setEditing((e) => !e)}>
          {editing ? "close" : "edit"}
        </button>
        <button className="btn ghost sm danger" onClick={onDelete}>
          delete
        </button>
      </div>
      {editing && (
        <div style={{ marginTop: 8, paddingLeft: 16, borderLeft: "2px solid var(--accent-line)" }}>
          <RoutineForm
            initial={routine}
            models={models}
            defaultModel={routine.model ?? ""}
            onCancel={() => setEditing(false)}
            onSubmit={async (patch) => {
              onUpdate({
                name: patch.name,
                cron: patch.cron,
                prompt: patch.prompt,
                model: patch.model ?? null,
                delivery: patch.delivery,
                enabled: patch.enabled ?? true,
              });
              setEditing(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface FormProps {
  initial?: RoutineRecord;
  models: Array<{ id: string; displayName: string; provider: string }>;
  defaultModel: string;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    cron: string;
    prompt: string;
    model?: string;
    delivery: DeliveryDraft;
    enabled?: boolean;
  }) => Promise<void>;
}

function RoutineForm({ initial, models, defaultModel, onCancel, onSubmit }: FormProps): JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * *");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [model, setModel] = useState(initial?.model ?? defaultModel);
  const [delivery, setDelivery] = useState<DeliveryDraft>(
    initial?.delivery ?? { kind: "dashboard" },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        cron: cron.trim(),
        prompt: prompt.trim(),
        ...(model ? { model } : {}),
        delivery,
        enabled: initial?.enabled ?? true,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const valid = name.trim() && cron.trim().split(/\s+/).length === 5 && prompt.trim();

  return (
    <Card title={initial ? "edit routine" : "new routine"}>
      <div className="col gap-3">
        <div className="row gap-3">
          <div style={{ flex: 1 }}>
            <div className="section-label">name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-digest" />
          </div>
          <div style={{ flex: 1 }}>
            <div className="section-label">cron</div>
            <input
              className="input mono"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="m h dom mon dow"
            />
            <div className="row gap-1" style={{ marginTop: 4, flexWrap: "wrap" }}>
              {SAMPLE_CRONS.map((s) => (
                <span
                  key={s.label}
                  className="chip"
                  style={{ cursor: "pointer" }}
                  onClick={() => setCron(s.cron)}
                  title={s.cron}
                >
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="section-label">prompt</div>
          <textarea
            className="input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="summarize yesterday's tasks…"
            style={{ minHeight: 80 }}
          />
        </div>
        <div className="row gap-3">
          <div style={{ flex: 1 }}>
            <div className="section-label">model</div>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">(gateway default)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
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
          <span className="hint">{valid ? "ready" : "fill name + 5-field cron + prompt"}</span>
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? "saving…" : initial ? "save changes" : "create routine"}
          </button>
        </div>
      </div>
    </Card>
  );
}
