import { useCallback, useEffect, useState } from "react";
import { Card, PageHead } from "../ui/primitives.js";
import { useGateway } from "../state/GatewayContext.js";
import type {
  PluginCatalogEntry,
  PluginConfigFieldDescription,
  PluginRecord,
  PluginSecretField,
} from "@squad/protocol";

interface Props {
  onOpenSession: (id: string) => void;
}

const KIND_COLOR: Record<string, string> = {
  tool: "",
  provider: "",
  channel: "info",
  skill: "accent",
  routine: "",
  subagent: "info",
};

interface DescribeResult {
  id: string;
  name: string;
  description: string;
  fields: PluginConfigFieldDescription[];
  defaultConfig: Record<string, unknown>;
  currentConfig?: Record<string, unknown>;
  needsAuthToken: boolean;
  secrets: PluginSecretField[];
  setupPlaybook?: string;
}

interface ConfigureModalState {
  catalogId: string;
  describe: DescribeResult;
  values: Record<string, string>;
  /** envVar → typed value. Separate map so we never confuse them with config. */
  secretValues: Record<string, string>;
  errors: Record<string, string>;
}

interface RpcError {
  code?: string;
  message?: string;
  data?: { code?: string; field?: string; envVar?: string; hint?: string; message?: string };
}

function isRpcError(e: unknown): e is RpcError {
  return typeof e === "object" && e !== null && ("code" in e || "data" in e || "message" in e);
}

/** Coerce the raw form string back to the typed value the gateway expects. */
function coerceField(field: PluginConfigFieldDescription, raw: string): unknown {
  if (raw === "" && !field.required) return undefined;
  switch (field.kind) {
    case "string":
    case "enum":
      return raw;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return raw === "true";
    case "array":
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

function defaultsFromDescribe(d: DescribeResult): Record<string, string> {
  const out: Record<string, string> = {};
  const current = d.currentConfig ?? {};
  for (const f of d.fields) {
    const cur = current[f.name];
    if (cur !== undefined && f.secret !== true) {
      out[f.name] = typeof cur === "string" ? cur : JSON.stringify(cur);
      continue;
    }
    if (f.default !== undefined) {
      out[f.name] =
        typeof f.default === "string" ? f.default : JSON.stringify(f.default);
      continue;
    }
    out[f.name] = "";
  }
  return out;
}

export function Plugins({ onOpenSession }: Props): JSX.Element {
  const { plugins, squad, client, reloadPlugin } = useGateway();
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configure, setConfigure] = useState<ConfigureModalState | null>(null);

  const refreshCatalog = useCallback(async (): Promise<void> => {
    try {
      const { entries } = await client.request("plugins.catalog", {});
      setCatalog(entries);
    } catch {
      setCatalog([]);
    }
  }, [client]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog, plugins]);

  const reloadAll = async (): Promise<void> => {
    await Promise.all(
      plugins.map((p) => reloadPlugin(p.id).catch(() => {})),
    );
  };

  // Open the configure modal for a catalog entry. We always go through
  // describe first so secrets render with the right "(set, leave blank to
  // keep)" placeholder.
  const openConfigure = async (id: string): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      const describe = (await client.request(
        "plugins.describe",
        { id },
      )) as DescribeResult;
      // Nothing to ask the user about (no schema fields AND no secrets, OR
      // every secret is already set) — install directly.
      const needsAnyInput =
        describe.fields.length > 0 ||
        (describe.secrets ?? []).some((s) => s.required && !s.set);
      if (!needsAnyInput) {
        await runInstall(id, {}, {});
        return;
      }
      setConfigure({
        catalogId: id,
        describe,
        values: defaultsFromDescribe(describe),
        secretValues: {},
        errors: {},
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Spin up a fresh chat session pre-loaded with the plugin's setupPlaybook
  // and navigate to it. The backend creates the session and renders the
  // briefing; we send it via `chat.send` from this connection (after
  // navigating) so the agent's reply streams over a subscription we're
  // already listening to.
  const startSetupChat = async (id: string): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      const { sessionId, seedMessage } = await client.request(
        "plugins.start_setup_chat",
        { id },
      );
      onOpenSession(sessionId);
      // One tick lag so the chat view's session-change effects (subscribe,
      // load history) run before the agent's response starts streaming.
      // Without this we occasionally raced the first text_delta and lost it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        await client.request("chat.send", { sessionId, content: seedMessage });
      } catch (sendErr) {
        // chat.send failure is loud — surface it so the user knows the
        // briefing didn't take. They can still type a follow-up to retry
        // by hand.
        setError(
          "setup chat opened, but the briefing didn't auto-send: " +
            (sendErr instanceof Error ? sendErr.message : String(sendErr)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Underlying install request. Pulled out so direct-install (no fields) and
  // modal-install share validation + error mapping.
  const runInstall = async (
    id: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<void> => {
    setBusyId(id);
    try {
      await client.request("plugins.install", {
        id,
        config,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
      await refreshCatalog();
      setConfigure(null);
      setError(null);
    } catch (e) {
      // Structured errors from the gateway carry `data.code` (missing_config,
      // import_failed, register_failed). Map missing_config back onto the
      // form so the user sees the offending field highlighted in place.
      if (isRpcError(e) && e.data?.code === "missing_config") {
        const fieldName = e.data.field ?? "";
        setConfigure((cur) =>
          cur && cur.catalogId === id
            ? {
                ...cur,
                errors: {
                  ...cur.errors,
                  ...(fieldName
                    ? { [fieldName]: e.data?.hint ?? e.data?.message ?? e.message ?? "Required" }
                    : {}),
                },
              }
            : cur,
        );
        setError(e.message ?? "Plugin needs configuration");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusyId(null);
    }
  };

  const submitConfigure = async (): Promise<void> => {
    if (!configure) return;
    // Validate required fields client-side so we don't round-trip just to
    // hear "field X is required" — server still re-validates.
    const errors: Record<string, string> = {};
    const config: Record<string, unknown> = {};
    for (const f of configure.describe.fields) {
      const raw = configure.values[f.name] ?? "";
      if (f.required && !f.secret && raw === "") {
        errors[f.name] = "Required";
        continue;
      }
      const coerced = coerceField(f, raw);
      if (coerced !== undefined) config[f.name] = coerced;
    }
    // Secrets: required-but-not-yet-set must be filled in this session.
    // When `set` is true on the describe payload the server already has a
    // value — empty input means "keep the existing one".
    const secrets: Record<string, string> = {};
    for (const s of configure.describe.secrets ?? []) {
      const raw = configure.secretValues[s.envVar] ?? "";
      if (s.required && !s.set && raw === "") {
        errors[s.envVar] = "Required";
        continue;
      }
      if (raw !== "") secrets[s.envVar] = raw;
    }
    if (Object.keys(errors).length > 0) {
      setConfigure({ ...configure, errors });
      return;
    }
    await runInstall(configure.catalogId, config, secrets);
  };

  const uninstall = async (id: string): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await client.request("plugins.uninstall", { id });
      await refreshCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  // UI contribution map: source-of-truth is each plugin's uiContributions
  // (set by the plugin via api.ui.contribute(...)). The dashboard groups
  // them by slot here.
  const SLOTS: Array<{ slot: string; desc: string }> = [
    { slot: "navTab", desc: "Top-nav entry" },
    { slot: "overviewWidget", desc: "Overview card" },
    { slot: "sessionPanel", desc: "Right column tab" },
    { slot: "toolRenderer", desc: "Tool call replacement" },
    { slot: "quickAction", desc: "⌘K palette entry" },
  ];
  const slots = SLOTS.map((s) => ({
    ...s,
    who: plugins
      .flatMap((p) => p.uiContributions.filter((c) => c.slot === s.slot).map((c) => p.id + ":" + c.id)),
  }));

  // For preinstalled plugins this toggle does an install/uninstall (which
  // actually mutates config.plugins[]); for any other plugin it falls back
  // to the legacy enable/disable metadata flag.
  const toggle = (p: PluginRecord): void => {
    const inCatalog = catalog.some((c) => c.id === p.id);
    if (inCatalog) {
      void (p.enabled ? uninstall(p.id) : openConfigure(p.id));
      return;
    }
    void client.request(p.enabled ? "plugins.disable" : "plugins.enable", { id: p.id }).catch(() => {});
  };

  return (
    <div>
      <PageHead
        title="plugins"
        crumbs={`${plugins.length} installed for ${squad?.name ?? "—"}`}
        actions={
          <div className="row gap-2">
            <button className="btn sm ghost" onClick={() => void reloadAll()} disabled={plugins.length === 0}>
              reload all
            </button>
            <span className="hint">
              configure below — values save to <span className="kbd">config.json</span>
            </span>
          </div>
        }
      />
      <div style={{ padding: 16 }}>
        {error && (
          <div
            className="card"
            style={{
              padding: 10,
              marginBottom: 12,
              borderColor: "var(--err)",
              color: "var(--err)",
            }}
          >
            {error}
          </div>
        )}

        {catalog.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="section-label" style={{ marginBottom: 8 }}>
              available plugins
            </div>
            <Card>
              {catalog.map((entry) => {
                const busy = busyId === entry.id;
                const failedRecord = plugins.find(
                  (p) => p.source === entry.source && p.status === "failed",
                );
                const stateLabel = failedRecord
                  ? "load error"
                  : entry.installed
                    ? entry.loaded
                      ? "on"
                      : "needs setup"
                    : "off";
                return (
                  <div
                    key={entry.id}
                    style={{
                      borderBottom: "1px solid var(--border-soft)",
                    }}
                  >
                    <div
                      className="row gap-2"
                      style={{
                        padding: "10px 14px",
                        fontSize: "var(--t-sm)",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{ width: 12 }}
                        className={
                          "dot " +
                          (failedRecord
                            ? "off"
                            : entry.installed && entry.loaded
                              ? "ok"
                              : "off")
                        }
                      />
                      <div style={{ width: 220 }}>
                        <div className="strong">{entry.name}</div>
                        <div className="mono faint" style={{ fontSize: 10 }}>
                          {entry.id}
                        </div>
                      </div>
                      <div style={{ flex: 1, color: "var(--fg-muted)" }}>
                        {entry.description}
                      </div>
                      <div style={{ width: 140, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {entry.kinds.map((k) => (
                          <span
                            key={k}
                            className={"tag " + (KIND_COLOR[k] ?? "")}
                            style={{ fontSize: 9 }}
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                      <span style={{ width: 110 }}>
                        <span
                          className={
                            "tag " +
                            (failedRecord ? "" : entry.loaded ? "ok" : "")
                          }
                        >
                          {stateLabel}
                        </span>
                      </span>
                      <button
                        className="btn sm ghost"
                        disabled={busy}
                        onClick={() => void startSetupChat(entry.id)}
                        title="open a chat where the agent walks you through setup"
                      >
                        setup with agent
                      </button>
                      <button
                        className="btn sm ghost"
                        disabled={busy}
                        onClick={() => void openConfigure(entry.id)}
                        title="open the configure form"
                      >
                        configure
                      </button>
                      <button
                        className={"btn sm " + (entry.installed ? "ghost" : "")}
                        disabled={busy}
                        onClick={() =>
                          void (entry.installed
                            ? uninstall(entry.id)
                            : openConfigure(entry.id))
                        }
                      >
                        {busy
                          ? "…"
                          : entry.installed
                            ? "disable"
                            : "enable"}
                      </button>
                    </div>
                    {failedRecord?.error && (
                      <div
                        style={{
                          padding: "8px 14px 12px 38px",
                          fontSize: "var(--t-xs)",
                          color: "var(--err)",
                          background: "var(--bg-inset)",
                        }}
                      >
                        <div className="strong">load failed: {failedRecord.error.code}</div>
                        <div className="mono">{failedRecord.error.message}</div>
                        {failedRecord.error.field && (
                          <div className="hint">
                            field <span className="kbd">{failedRecord.error.field}</span>
                            {failedRecord.error.envVar && (
                              <>
                                {" "}— env var <span className="kbd">{failedRecord.error.envVar}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          </div>
        )}

        <div className="section-label" style={{ marginBottom: 8 }}>
          installed plugins
        </div>
        <Card>
          <div
            className="row gap-2"
            style={{
              padding: "6px 14px",
              borderBottom: "1px solid var(--border-soft)",
              fontSize: "var(--t-xs)",
              color: "var(--fg-faint)",
              textTransform: "uppercase",
              letterSpacing: ".08em",
            }}
          >
            <span style={{ width: 12 }} />
            <span style={{ width: 200 }}>plugin</span>
            <span style={{ width: 60 }}>ver</span>
            <span style={{ width: 100 }}>source</span>
            <span style={{ width: 160 }}>kinds</span>
            <span style={{ width: 200 }}>ui contributions</span>
            <span style={{ flex: 1 }}>installed</span>
            <span style={{ width: 120 }}>status</span>
          </div>
          {plugins.length === 0 && (
            <div className="hint" style={{ padding: 14 }}>
              no plugins installed. enable one above or via{" "}
              <span className="kbd">squad plugins install &lt;id&gt;</span>.
            </div>
          )}
          {plugins.map((p) => (
            <div
              key={p.id}
              style={{
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              <div
                className="row gap-2"
                style={{
                  padding: "10px 14px",
                  fontSize: "var(--t-sm)",
                }}
              >
                <span
                  style={{ width: 12 }}
                  className={
                    "dot " + (p.status === "failed" ? "off" : p.enabled ? "ok" : "off")
                  }
                />
                <div style={{ width: 200 }}>
                  <div className="strong">{p.name}</div>
                  <div className="mono faint" style={{ fontSize: 10 }}>
                    {p.id}
                  </div>
                </div>
                <span className="mono" style={{ width: 60 }}>
                  {p.version}
                </span>
                <span style={{ width: 100 }}>
                  <span
                    className="tag"
                    title={p.source}
                    style={{
                      maxWidth: 90,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "inline-block",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sourceKind(p.source)}
                  </span>
                </span>
                <div style={{ width: 160, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {p.kinds.map((k) => (
                    <span key={k} className={"tag " + (KIND_COLOR[k] ?? "")} style={{ fontSize: 9 }}>
                      {k}
                    </span>
                  ))}
                </div>
                <div style={{ width: 200, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {p.uiContributions.length === 0 ? (
                    <span className="dim">—</span>
                  ) : (
                    p.uiContributions.map((c) => (
                      <span
                        key={c.slot + c.id}
                        className="chip on"
                        style={{ fontSize: 9 }}
                        title={c.label}
                      >
                        {c.slot}
                      </span>
                    ))
                  )}
                </div>
                <span style={{ flex: 1, color: "var(--fg-muted)", fontSize: "var(--t-xs)" }} className="mono">
                  {p.installedAt ? new Date(p.installedAt).toISOString().slice(0, 10) : "—"}
                </span>
                <span style={{ width: 160 }} className="row gap-2">
                  {p.status === "failed" ? (
                    <span className="tag" style={{ color: "var(--err)" }}>failed</span>
                  ) : p.enabled ? (
                    <span className="tag ok">enabled</span>
                  ) : (
                    <span className="tag">disabled</span>
                  )}
                  <button className="btn ghost sm" onClick={() => toggle(p)}>
                    {p.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={() => void reloadPlugin(p.id).catch(() => {})}
                    title="re-import this plugin"
                  >
                    reload
                  </button>
                </span>
              </div>
              {p.status === "failed" && p.error && (
                <div
                  style={{
                    padding: "6px 14px 10px 38px",
                    fontSize: "var(--t-xs)",
                    color: "var(--err)",
                    background: "var(--bg-inset)",
                  }}
                >
                  <span className="strong">{p.error.code}: </span>
                  <span className="mono">{p.error.message}</span>
                </div>
              )}
            </div>
          ))}
        </Card>

        <div style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>
            ui contribution map
          </div>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
              {slots.map((s) => (
                <div
                  key={s.slot}
                  style={{
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border-soft)",
                    borderRadius: 3,
                    padding: 10,
                  }}
                >
                  <div className="mono strong" style={{ fontSize: "var(--t-sm)" }}>
                    {s.slot}
                  </div>
                  <div className="hint" style={{ marginBottom: 6 }}>
                    {s.desc}
                  </div>
                  <div className="col gap-1">
                    {s.who.length === 0 && <span className="dim">—</span>}
                    {s.who.map((w) => (
                      <span key={w} className="chip on" style={{ fontSize: 9 }}>
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {configure && (
        <ConfigureModal
          state={configure}
          busy={busyId === configure.catalogId}
          onChange={(name, value) =>
            setConfigure((cur) =>
              cur
                ? {
                    ...cur,
                    values: { ...cur.values, [name]: value },
                    errors: { ...cur.errors, [name]: "" },
                  }
                : cur,
            )
          }
          onChangeSecret={(envVar, value) =>
            setConfigure((cur) =>
              cur
                ? {
                    ...cur,
                    secretValues: { ...cur.secretValues, [envVar]: value },
                    errors: { ...cur.errors, [envVar]: "" },
                  }
                : cur,
            )
          }
          onCancel={() => setConfigure(null)}
          onSubmit={() => void submitConfigure()}
        />
      )}
    </div>
  );
}

function ConfigureModal(props: {
  state: ConfigureModalState;
  busy: boolean;
  onChange: (name: string, value: string) => void;
  onChangeSecret: (envVar: string, value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const { state, busy, onChange, onChangeSecret, onCancel, onSubmit } = props;
  return (
    <div
      role="dialog"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{
          width: 520,
          maxWidth: "90vw",
          maxHeight: "85vh",
          overflow: "auto",
          padding: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-soft)",
          }}
        >
          <div className="strong">configure {state.describe.name}</div>
          <div className="hint">{state.describe.description}</div>
          {state.describe.needsAuthToken && (
            <div className="hint" style={{ marginTop: 4 }}>
              install will create a matching <span className="kbd">auth.tokens</span> entry.
            </div>
          )}
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {state.describe.fields.map((field) => (
            <FieldRow
              key={field.name}
              field={field}
              value={state.values[field.name] ?? ""}
              error={state.errors[field.name]}
              onChange={(v) => onChange(field.name, v)}
            />
          ))}
          {(state.describe.secrets ?? []).length > 0 && (
            <div className="hint" style={{ marginTop: 4 }}>
              The values below are stored locally (mode 0600) and merged into{" "}
              <span className="kbd">process.env</span> at boot — they never get written to{" "}
              <span className="kbd">config.json</span>.
            </div>
          )}
          {(state.describe.secrets ?? []).map((s) => (
            <SecretRow
              key={s.envVar}
              secret={s}
              value={state.secretValues[s.envVar] ?? ""}
              error={state.errors[s.envVar]}
              onChange={(v) => onChangeSecret(s.envVar, v)}
            />
          ))}
        </div>
        <div
          className="row gap-2"
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border-soft)",
            justifyContent: "flex-end",
          }}
        >
          <button className="btn sm ghost" onClick={onCancel} disabled={busy}>
            cancel
          </button>
          <button className="btn sm" onClick={onSubmit} disabled={busy}>
            {busy ? "installing…" : "install"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow(props: {
  field: PluginConfigFieldDescription;
  value: string;
  error?: string | undefined;
  onChange: (v: string) => void;
}): JSX.Element {
  const { field, value, error, onChange } = props;
  const label = (
    <label
      style={{ fontSize: "var(--t-xs)", textTransform: "uppercase", letterSpacing: ".08em" }}
    >
      {field.name}
      {field.required && !field.secret && <span style={{ color: "var(--err)" }}> *</span>}
      {field.envRef && <span className="hint"> (env var name)</span>}
      {field.secret && <span className="hint"> (auto-generated if blank)</span>}
    </label>
  );
  let input: JSX.Element;
  if (field.kind === "enum" && field.options) {
    input = (
      <select className="input sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  } else if (field.kind === "boolean") {
    input = (
      <select className="input sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  } else if (field.kind === "array" || field.kind === "json") {
    input = (
      <textarea
        className="input sm"
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.kind === "array" ? "[]" : "{}"}
        style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
      />
    );
  } else {
    input = (
      <input
        className="input sm"
        type={field.secret ? "password" : "text"}
        value={value}
        placeholder={
          field.secret
            ? "(leave blank to auto-generate)"
            : field.default !== undefined
              ? String(field.default)
              : ""
        }
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="col" style={{ gap: 4 }}>
      {label}
      {input}
      {field.description && <div className="hint">{field.description}</div>}
      {error && <div style={{ color: "var(--err)", fontSize: "var(--t-xs)" }}>{error}</div>}
    </div>
  );
}

function SecretRow(props: {
  secret: PluginSecretField;
  value: string;
  error?: string | undefined;
  onChange: (v: string) => void;
}): JSX.Element {
  const { secret, value, error, onChange } = props;
  return (
    <div className="col" style={{ gap: 4 }}>
      <label
        style={{ fontSize: "var(--t-xs)", textTransform: "uppercase", letterSpacing: ".08em" }}
      >
        {secret.label ?? secret.envVar}
        {secret.required && !secret.set && <span style={{ color: "var(--err)" }}> *</span>}
        <span className="hint"> · ${secret.envVar}</span>
        {secret.set && <span className="hint"> (already set — leave blank to keep)</span>}
      </label>
      <input
        className="input sm"
        type="password"
        value={value}
        placeholder={secret.set ? "(leave blank to keep current value)" : ""}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {secret.hint && <div className="hint">{secret.hint}</div>}
      {error && <div style={{ color: "var(--err)", fontSize: "var(--t-xs)" }}>{error}</div>}
    </div>
  );
}

function sourceKind(src: string): string {
  if (src.startsWith("npm:")) return "npm";
  if (src.startsWith("/") || src.startsWith("./") || src.startsWith("../")) return "local";
  if (src.includes("node_modules")) return "npm";
  if (src.startsWith("workspace:")) return "workspace";
  return "builtin";
}
