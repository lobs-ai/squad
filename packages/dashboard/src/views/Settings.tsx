import { useEffect, useMemo, useState } from "react";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway, type FullConfigState } from "../state/GatewayContext.js";
import { fmtAgo } from "../state/fmt.js";

interface Props {
  theme: string;
  setTheme: (v: string) => void;
  density: string;
  setDensity: (v: string) => void;
  accent: string;
  setAccent: (v: string) => void;
}

const SECTIONS = [
  { id: "squad", label: "squad" },
  { id: "providers", label: "providers + keys" },
  { id: "models", label: "models" },
  { id: "subagents", label: "subagents" },
  { id: "approvals", label: "approvals" },
  { id: "chat", label: "chat delivery" },
  { id: "auth", label: "auth tokens" },
  { id: "plugins", label: "plugins" },
  { id: "server", label: "server" },
  { id: "pairings", label: "pairings" },
  { id: "channels", label: "channels" },
  { id: "raw", label: "raw config.json" },
  { id: "theme", label: "theme" },
  { id: "shortcuts", label: "shortcuts" },
] as const;

const ACCENTS: Array<{ name: string; hex: string }> = [
  { name: "squad blue", hex: "#5b8def" },
  { name: "amber", hex: "#f59e0b" },
  { name: "lime", hex: "#a3e635" },
  { name: "magenta", hex: "#c084fc" },
  { name: "cyan", hex: "#67e8f9" },
];

// Common, well-known providers — surfaced as suggestions when the user adds a
// new provider. The gateway accepts arbitrary keys here (custom local proxies
// like `minimax/minimax-m2.7` route through a base_url override), so the list
// is a hint, not a constraint.
const KNOWN_PROVIDERS = ["anthropic", "openai", "google", "groq", "openrouter", "mistral"];

export function Settings({ theme, setTheme, density, setDensity, accent, setAccent }: Props): JSX.Element {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("squad");
  const {
    config,
    fullConfig,
    models,
    squad,
    peers,
    pairings,
    channels,
    cancelPairing,
    setConfigPath,
    unsetConfigPath,
    refreshFullConfig,
  } = useGateway();

  const editable = !!fullConfig?.editable;

  return (
    <div>
      <PageHead title="settings" crumbs={squad?.name ?? "—"} />
      <div
        style={{
          padding: 16,
          display: "grid",
          gridTemplateColumns: "180px 1fr",
          gap: 16,
        }}
      >
        <div>
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                padding: "6px 10px",
                borderLeft: "2px solid " + (section === s.id ? "var(--accent)" : "transparent"),
                background: section === s.id ? "var(--bg-card)" : "transparent",
                color: section === s.id ? "var(--fg-strong)" : "var(--fg-muted)",
                cursor: "pointer",
                fontSize: "var(--t-sm)",
              }}
            >
              {s.label}
            </div>
          ))}
        </div>
        <div>
          {!editable && fullConfig && section !== "theme" && section !== "shortcuts" && section !== "squad" && section !== "pairings" && section !== "channels" && (
            <Card>
              <div className="hint" style={{ padding: 4 }}>
                this gateway is running without a <span className="kbd">SQUAD_CONFIG</span> file —
                edits below will be rejected. set the env var, restart, and refresh the dashboard
                to enable writes.
              </div>
            </Card>
          )}

          {section === "squad" && squad && (
            <Card title={`squad · ${squad.name}`} badge={<span className="tag ok">{squad.status}</span>}>
              <div className="row-list">
                <Row k="name" v={squad.name} />
                <Row k="port" v={`:${squad.port}`} />
                <Row k="host" v={squad.host} />
                <Row k="version" v={squad.version} />
                {squad.build && <Row k="build" v={squad.build} />}
                <Row k="started" v={squad.startedAt ? fmtAgo(squad.startedAt) : "—"} />
                <Row k="active sessions" v={String(squad.activeSessions)} />
                <Row k="total sessions" v={String(squad.totalSessions)} />
                <Row k="dashboard url" v={`${window.location.protocol}//${squad.host}:${squad.port}/`} />
                <Row k="websocket" v={`${window.location.protocol === "https:" ? "wss" : "ws"}://${squad.host}:${squad.port}/ws`} />
                {fullConfig?.path && <Row k="config file" v={fullConfig.path} />}
              </div>
              {peers.length > 1 && (
                <div className="hint" style={{ marginTop: 12 }}>
                  {peers.length - 1} sibling squad{peers.length === 2 ? "" : "s"} on this host — see the{" "}
                  <span className="link">manager view</span>.
                </div>
              )}
            </Card>
          )}

          {section === "providers" && (
            <ProvidersEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
              unsetConfigPath={unsetConfigPath}
            />
          )}

          {section === "models" && (
            <ModelsEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
              unsetConfigPath={unsetConfigPath}
              models={models.map((m) => m.id)}
              configuredPrimary={config?.primary.model ?? null}
              configuredFallbacks={(config?.fallbacks ?? []).map((f) => f.model)}
            />
          )}

          {section === "subagents" && (
            <SubagentsEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
            />
          )}

          {section === "approvals" && (
            <ApprovalsEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
            />
          )}

          {section === "chat" && (
            <ChatEditor fullConfig={fullConfig} setConfigPath={setConfigPath} />
          )}

          {section === "auth" && (
            <AuthTokensEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
              unsetConfigPath={unsetConfigPath}
            />
          )}

          {section === "plugins" && (
            <PluginsEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
              unsetConfigPath={unsetConfigPath}
            />
          )}

          {section === "server" && (
            <ServerEditor fullConfig={fullConfig} setConfigPath={setConfigPath} />
          )}

          {section === "pairings" && (
            <Card
              title="browser pairings"
              badge={<span className="tag">{pairings.length}</span>}
            >
              <div className="hint" style={{ marginBottom: 10 }}>
                each pairing is a per-browser bearer token. <strong>claimed</strong> entries
                are active sessions and persist across gateway restarts; revoke one here
                to log that browser out immediately.
              </div>
              {pairings.length === 0 && <div className="hint">no pairings.</div>}
              <div className="row-list">
                {pairings.map((p) => (
                  <div
                    key={p.code}
                    className="row gap-3"
                    style={{ padding: "8px 0", fontSize: "var(--t-sm)" }}
                  >
                    <span
                      className={
                        "dot " +
                        (p.status === "claimed"
                          ? "ok"
                          : p.status === "approved"
                            ? "ok pulse"
                            : p.status === "pending"
                              ? "accent pulse"
                              : p.status === "expired"
                                ? "warn"
                                : "off")
                      }
                    />
                    <span className="mono accent" style={{ width: 130, color: "var(--accent)" }}>
                      {p.code}
                    </span>
                    <span style={{ flex: 1 }}>{p.label}</span>
                    <span className={"tag " + (p.status === "claimed" ? "ok" : "")}>
                      {p.status === "claimed" ? "active" : p.status}
                    </span>
                    {p.persistent && (
                      <span className="tag" title="persisted to <data_dir>/pairings.json — survives restarts">
                        persistent
                      </span>
                    )}
                    <span className="hint" style={{ width: 110 }}>
                      {p.claimedAt
                        ? `claimed ${fmtAgo(p.claimedAt)}`
                        : p.approvedAt
                          ? `approved ${fmtAgo(p.approvedAt)}`
                          : fmtAgo(p.createdAt)}
                    </span>
                    <span className="hint" style={{ width: 130 }}>
                      {p.approvedBy ? `by ${p.approvedBy}` : ""}
                    </span>
                    <span className="spacer" />
                    {p.status !== "expired" && p.status !== "cancelled" && (
                      <button className="btn ghost sm" onClick={() => void cancelPairing(p.code)}>
                        revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                cli: <span className="kbd">squad pair browser list</span> ·{" "}
                <span className="kbd">squad pair browser cancel &lt;code&gt;</span>
              </div>
            </Card>
          )}

          {section === "channels" && (
            <Card
              title="channels"
              badge={<span className="tag">{channels.length}</span>}
            >
              {channels.length === 0 && (
                <div className="hint">no channel plugins loaded.</div>
              )}
              <div className="row-list">
                {channels.map((c) => (
                  <div
                    key={c.id}
                    className="row gap-3"
                    style={{ padding: "8px 0", fontSize: "var(--t-sm)" }}
                  >
                    <span className={"dot " + (c.connected ? "ok" : "off")} />
                    <span className="mono" style={{ width: 80 }}>{c.kind}</span>
                    <span style={{ flex: 1 }}>{c.label}</span>
                    <span className="tag">{c.connected ? "connected" : "offline"}</span>
                  </div>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                channel plugins are configured under <span className="kbd">plugins</span> — wire a
                channel package there to add a new transport.
              </div>
            </Card>
          )}

          {section === "raw" && (
            <RawConfigViewer fullConfig={fullConfig} refresh={refreshFullConfig} />
          )}

          {section === "theme" && (
            <Card title="theme">
              <div className="col gap-3">
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    mode
                  </div>
                  <div className="row gap-2">
                    {["dark", "light", "hi-contrast"].map((t) => (
                      <button
                        key={t}
                        className={"btn sm " + (theme === t ? "primary" : "")}
                        onClick={() => setTheme(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    density
                  </div>
                  <div className="row gap-2">
                    {["comfortable", "compact"].map((t) => (
                      <button
                        key={t}
                        className={"btn sm " + (density === t ? "primary" : "")}
                        onClick={() => setDensity(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="section-label" style={{ marginBottom: 6 }}>
                    accent
                  </div>
                  <div className="row gap-2">
                    {ACCENTS.map((c) => (
                      <button
                        key={c.name}
                        className="btn sm"
                        onClick={() => setAccent(c.hex)}
                        style={{
                          borderColor: accent === c.hex ? c.hex : "var(--border)",
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 2,
                            background: c.hex,
                            display: "inline-block",
                          }}
                        />
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {section === "shortcuts" && (
            <Card title="keyboard">
              <div className="row-list">
                {[
                  ["⌘K", "open command palette"],
                  ["⌘N", "new chat"],
                  ["⌘↵", "send message"],
                  ["g o", "go to overview"],
                  ["g c", "go to chat"],
                  ["g t", "go to tasks"],
                  ["g s", "go to sessions"],
                  ["g p", "go to plugins"],
                  ["g m", "open manager"],
                ].map(([k, d]) => (
                  <div key={k} className="row gap-2" style={{ padding: "5px 0" }}>
                    <span className="kbd" style={{ minWidth: 56, textAlign: "center" }}>
                      {k}
                    </span>
                    <span style={{ fontSize: "var(--t-sm)" }}>{d}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPath(obj: unknown, segments: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="row gap-2" style={{ padding: "5px 0", fontSize: "var(--t-sm)" }}>
      <span className="faint" style={{ minWidth: 140 }}>
        {k}
      </span>
      <span className="mono">{v}</span>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  initial: string | number | undefined;
  type?: "text" | "number" | "password";
  placeholder?: string;
  disabled?: boolean;
  onSave: (raw: string) => Promise<void>;
  onClear?: () => Promise<void>;
}

/**
 * Inline editable field. Stores the user's draft locally; "save" only fires
 * on blur or explicit click so a partial keystroke can't truncate the value
 * on disk. Reset to the latest server value when `initial` changes.
 */
function Field({ label, hint, initial, type = "text", placeholder, disabled, onSave, onClear }: FieldProps): JSX.Element {
  const stringInit = initial === undefined || initial === null ? "" : String(initial);
  const [draft, setDraft] = useState(stringInit);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(stringInit), [stringInit]);

  const dirty = draft !== stringInit;

  const save = async (): Promise<void> => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e) {
      setError((e as Error).message ?? "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="col" style={{ marginBottom: 12 }}>
      <div className="row gap-2" style={{ marginBottom: 4, alignItems: "baseline" }}>
        <span className="section-label" style={{ minWidth: 140 }}>{label}</span>
        {dirty && <span className="tag warn">unsaved</span>}
        {error && <span className="tag warn" title={error}>error</span>}
      </div>
      <div className="row gap-2">
        <input
          className="input"
          type={type === "password" && !reveal ? "password" : type === "number" ? "number" : "text"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
            if (e.key === "Escape") {
              setDraft(stringInit);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          placeholder={placeholder}
          disabled={disabled || saving}
          style={{ flex: 1 }}
        />
        {type === "password" && (
          <button className="btn ghost sm" onClick={() => setReveal((r) => !r)} disabled={disabled}>
            {reveal ? "hide" : "show"}
          </button>
        )}
        {dirty && (
          <button className="btn primary sm" onClick={() => void save()} disabled={saving}>
            save
          </button>
        )}
        {onClear && stringInit !== "" && !dirty && (
          <button className="btn ghost sm" onClick={() => void onClear()} disabled={disabled}>
            clear
          </button>
        )}
      </div>
      {hint && <div className="hint" style={{ marginTop: 4 }}>{hint}</div>}
      {error && <div className="hint" style={{ color: "var(--warn)", marginTop: 4 }}>{error}</div>}
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  hint?: string;
  initial: number | undefined;
  min?: number;
  max?: number;
  disabled?: boolean;
  onSave: (n: number) => Promise<void>;
}

function NumberField({ label, hint, initial, min, max, disabled, onSave }: NumberFieldProps): JSX.Element {
  return (
    <Field
      label={label}
      hint={hint}
      type="number"
      initial={initial ?? ""}
      disabled={disabled}
      onSave={async (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error("not a number");
        if (min !== undefined && n < min) throw new Error(`must be >= ${min}`);
        if (max !== undefined && n > max) throw new Error(`must be <= ${max}`);
        await onSave(n);
      }}
    />
  );
}

interface SelectFieldProps {
  label: string;
  hint?: string;
  value: string | undefined;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (v: string) => Promise<void>;
}

function SelectField({ label, hint, value, options, disabled, onChange }: SelectFieldProps): JSX.Element {
  const [pending, setPending] = useState(false);
  return (
    <div className="col" style={{ marginBottom: 12 }}>
      <div className="section-label" style={{ marginBottom: 4 }}>{label}</div>
      <select
        className="input"
        value={value ?? ""}
        disabled={disabled || pending}
        onChange={(e) => {
          const v = e.target.value;
          setPending(true);
          void onChange(v).finally(() => setPending(false));
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <div className="hint" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const RESTART_HINT = "takes effect on next gateway restart.";
const LIVE_HINT = "takes effect immediately for new sessions.";

// ─────────────────────────────────────────────────────────────────────────────
// providers
// ─────────────────────────────────────────────────────────────────────────────

function ProvidersEditor({
  fullConfig,
  setConfigPath,
  unsetConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const providers =
    (getPath(fullConfig?.config, ["llm", "providers"]) as Record<string, ProviderEntry>) ?? {};
  const names = Object.keys(providers).sort();

  const [newProvider, setNewProvider] = useState("");

  const addProvider = async (name: string): Promise<void> => {
    if (!name.trim()) return;
    const cleaned = name.trim();
    if (providers[cleaned]) return;
    await setConfigPath(`llm.providers.${cleaned}`, { api_key_env: defaultEnvFor(cleaned) });
    setNewProvider("");
  };

  return (
    <Card
      title="providers"
      badge={<span className="tag">{names.length}</span>}
    >
      <div className="hint" style={{ marginBottom: 12 }}>
        each provider needs an api key — either an env var name (read from the gateway process)
        or a literal key stored in <span className="kbd">config.json</span>. {RESTART_HINT} key
        env vars are preferred for secrets that shouldn't land on disk.
      </div>
      {names.length === 0 && (
        <div className="hint" style={{ padding: 12 }}>
          no providers configured — add one below to wire up a model.
        </div>
      )}
      {names.map((name) => (
        <ProviderCard
          key={name}
          name={name}
          entry={providers[name] ?? {}}
          editable={editable}
          setConfigPath={setConfigPath}
          unsetConfigPath={unsetConfigPath}
        />
      ))}
      <div
        className="row gap-2"
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border-soft)",
          alignItems: "center",
        }}
      >
        <span className="section-label">add provider</span>
        <input
          className="input"
          list="known-providers"
          placeholder="anthropic | openai | google | …"
          value={newProvider}
          onChange={(e) => setNewProvider(e.target.value)}
          style={{ flex: 1 }}
          disabled={!editable}
        />
        <datalist id="known-providers">
          {KNOWN_PROVIDERS.filter((p) => !providers[p]).map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <button
          className="btn primary sm"
          onClick={() => void addProvider(newProvider)}
          disabled={!editable || !newProvider.trim()}
        >
          add
        </button>
      </div>
    </Card>
  );
}

interface ProviderEntry {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
}

function defaultEnvFor(name: string): string {
  switch (name) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "groq":
      return "GROQ_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "mistral":
      return "MISTRAL_API_KEY";
    default:
      return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
  }
}

function ProviderCard({
  name,
  entry,
  editable,
  setConfigPath,
  unsetConfigPath,
}: {
  name: string;
  entry: ProviderEntry;
  editable: boolean;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const base = `llm.providers.${name}`;
  return (
    <div
      style={{
        marginBottom: 12,
        padding: 12,
        background: "var(--bg-card)",
        border: "1px solid var(--border-soft)",
        borderRadius: 4,
      }}
    >
      <div className="row gap-2" style={{ alignItems: "center", marginBottom: 8 }}>
        <span className="mono strong" style={{ flex: 1 }}>{name}</span>
        <span className="tag">{entry.api_key ? "literal key" : entry.api_key_env ? `env: ${entry.api_key_env}` : "no key"}</span>
        <button
          className="btn ghost sm"
          onClick={() => void unsetConfigPath(base)}
          disabled={!editable}
          title="remove this provider entirely"
        >
          <Icon name="x" /> remove
        </button>
      </div>
      <Field
        label="api_key_env"
        hint="env var name on the gateway host (e.g. ANTHROPIC_API_KEY)"
        initial={entry.api_key_env}
        placeholder={defaultEnvFor(name)}
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") {
            await unsetConfigPath(`${base}.api_key_env`);
          } else {
            await setConfigPath(`${base}.api_key_env`, raw.trim());
          }
        }}
        onClear={() => unsetConfigPath(`${base}.api_key_env`)}
      />
      <Field
        label="api_key"
        hint="literal api key. avoid when possible — prefer api_key_env so the secret stays out of config.json."
        type="password"
        initial={entry.api_key}
        placeholder="sk-…"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") {
            await unsetConfigPath(`${base}.api_key`);
          } else {
            await setConfigPath(`${base}.api_key`, raw);
          }
        }}
        onClear={() => unsetConfigPath(`${base}.api_key`)}
      />
      <Field
        label="base_url"
        hint="optional. override the provider's endpoint (proxies, on-prem, custom relays)."
        initial={entry.base_url}
        placeholder="https://api.example.com/v1"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") {
            await unsetConfigPath(`${base}.base_url`);
          } else {
            await setConfigPath(`${base}.base_url`, raw.trim());
          }
        }}
        onClear={() => unsetConfigPath(`${base}.base_url`)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// models
// ─────────────────────────────────────────────────────────────────────────────

function ModelsEditor({
  fullConfig,
  setConfigPath,
  unsetConfigPath,
  models,
  configuredPrimary,
  configuredFallbacks,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
  models: string[];
  configuredPrimary: string | null;
  configuredFallbacks: string[];
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const cfg = fullConfig?.config;
  const primaryRaw = getPath(cfg, ["llm", "primary"]);
  const primary =
    typeof primaryRaw === "string"
      ? primaryRaw
      : ((primaryRaw as { model?: string } | undefined)?.model ?? configuredPrimary ?? "");
  const fallbacksRaw = (getPath(cfg, ["llm", "fallbacks"]) as Array<string | { model: string }> | undefined) ?? [];
  const fallbacks: string[] = fallbacksRaw.map((f) => (typeof f === "string" ? f : f.model));
  const effective = fallbacks.length > 0 ? fallbacks : configuredFallbacks;

  const [newFallback, setNewFallback] = useState("");

  return (
    <Card
      title="models"
      badge={<span className="tag">{models.length} available</span>}
    >
      <div className="hint" style={{ marginBottom: 12 }}>
        the runner tries <strong>primary</strong> first; on a fallback-eligible failure (rate
        limit, 5xx, timeout) it advances to the next entry and stays there for the rest of the
        session. {RESTART_HINT}
      </div>
      <Field
        label="primary"
        hint="model id. matches one of the available models below or a custom string for unknown providers."
        initial={primary}
        placeholder="claude-sonnet-4-5"
        disabled={!editable}
        onSave={async (raw) => {
          await setConfigPath("llm.primary", { model: raw.trim() });
        }}
      />
      <div className="section-label" style={{ marginTop: 8, marginBottom: 6 }}>
        fallbacks
      </div>
      {effective.length === 0 && <div className="hint" style={{ marginBottom: 8 }}>no fallbacks — primary failures bubble up.</div>}
      <div className="row-list" style={{ marginBottom: 8 }}>
        {fallbacks.map((m, i) => (
          <div key={`${m}:${i}`} className="row gap-2" style={{ padding: "6px 0" }}>
            <span className="faint" style={{ width: 24 }}>{i + 1}.</span>
            <span className="mono" style={{ flex: 1 }}>{m}</span>
            <button
              className="btn ghost sm"
              disabled={!editable || i === 0}
              onClick={async () => {
                const next = [...fallbacks];
                [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                await setConfigPath("llm.fallbacks", next.map((x) => ({ model: x })));
              }}
              title="move up"
            >
              ↑
            </button>
            <button
              className="btn ghost sm"
              disabled={!editable || i === fallbacks.length - 1}
              onClick={async () => {
                const next = [...fallbacks];
                [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
                await setConfigPath("llm.fallbacks", next.map((x) => ({ model: x })));
              }}
              title="move down"
            >
              ↓
            </button>
            <button
              className="btn ghost sm"
              disabled={!editable}
              onClick={async () => {
                const next = fallbacks.filter((_, j) => j !== i);
                await setConfigPath("llm.fallbacks", next.map((x) => ({ model: x })));
              }}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
      <div className="row gap-2">
        <input
          className="input"
          list="known-models"
          placeholder="add fallback model id"
          value={newFallback}
          onChange={(e) => setNewFallback(e.target.value)}
          style={{ flex: 1 }}
          disabled={!editable}
        />
        <datalist id="known-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button
          className="btn primary sm"
          disabled={!editable || !newFallback.trim()}
          onClick={async () => {
            const m = newFallback.trim();
            if (!m) return;
            const next = [...fallbacks, m];
            await setConfigPath("llm.fallbacks", next.map((x) => ({ model: x })));
            setNewFallback("");
          }}
        >
          add
        </button>
      </div>
      <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>available models (admin.models)</div>
      <div className="hint" style={{ marginBottom: 6 }}>
        what the gateway thinks it can call right now — primary + fallbacks merged with the
        catalog of known models.
      </div>
      <div className="row-list">
        {models.length === 0 && <div className="hint">no models — wire a provider first.</div>}
        {models.map((m) => (
          <div key={m} className="row gap-2" style={{ padding: "4px 0", fontSize: "var(--t-sm)" }}>
            <span className="mono">{m}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// subagents
// ─────────────────────────────────────────────────────────────────────────────

function SubagentsEditor({
  fullConfig,
  setConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const cfg = (getPath(fullConfig?.config, ["subagents"]) as
    | {
        max_concurrent_global?: number;
        max_concurrent_per_parent?: number;
        max_tree_depth?: number;
      }
    | undefined) ?? {};
  return (
    <Card title="subagents">
      <div className="hint" style={{ marginBottom: 12 }}>
        caps how many subagents can run at once and how deep the spawn tree can go. {RESTART_HINT}
      </div>
      <NumberField
        label="max_concurrent_global"
        hint="hard ceiling across all sessions — the pool refuses spawns past this."
        initial={cfg.max_concurrent_global}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("subagents.max_concurrent_global", n)}
      />
      <NumberField
        label="max_concurrent_per_parent"
        hint="how many siblings a single agent can have running at once."
        initial={cfg.max_concurrent_per_parent}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("subagents.max_concurrent_per_parent", n)}
      />
      <NumberField
        label="max_tree_depth"
        hint="how deep the chain can recurse. 1 = root only spawns leaves."
        initial={cfg.max_tree_depth}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("subagents.max_tree_depth", n)}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// approvals
// ─────────────────────────────────────────────────────────────────────────────

function ApprovalsEditor({
  fullConfig,
  setConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const cfg = (getPath(fullConfig?.config, ["policy", "approvals"]) as
    | {
        default?: "tag-match" | "allow-all" | "deny-all";
        require_for_tags?: string[];
        timeout_seconds?: number;
      }
    | undefined) ?? {};
  const tags = cfg.require_for_tags ?? ["write", "exec", "network"];
  const [newTag, setNewTag] = useState("");

  return (
    <Card title="approvals">
      <div className="hint" style={{ marginBottom: 12 }}>
        gate which tools require user approval before running. {LIVE_HINT}
      </div>
      <SelectField
        label="default policy"
        hint="tag-match: prompt only for tools tagged below. allow-all / deny-all bypass tags entirely."
        value={cfg.default ?? "tag-match"}
        options={[
          { value: "tag-match", label: "tag-match" },
          { value: "allow-all", label: "allow-all (auto-approve everything)" },
          { value: "deny-all", label: "deny-all (block everything)" },
        ]}
        disabled={!editable}
        onChange={(v) => setConfigPath("policy.approvals.default", v)}
      />
      <NumberField
        label="timeout_seconds"
        hint="how long the agent waits for an answer before treating it as a denial."
        initial={cfg.timeout_seconds}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("policy.approvals.timeout_seconds", n)}
      />
      <div className="section-label" style={{ marginTop: 8, marginBottom: 6 }}>
        require_for_tags
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        tools tagged with any of these will prompt for approval. common: write, exec, network.
      </div>
      <div className="row gap-1" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        {tags.map((t) => (
          <span key={t} className="chip">
            {t}
            <button
              className="btn ghost sm"
              style={{ padding: "0 4px", marginLeft: 4 }}
              disabled={!editable}
              onClick={() =>
                void setConfigPath(
                  "policy.approvals.require_for_tags",
                  tags.filter((x) => x !== t),
                )
              }
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="row gap-2">
        <input
          className="input"
          placeholder="add tag (e.g. delete)"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          style={{ flex: 1 }}
          disabled={!editable}
        />
        <button
          className="btn primary sm"
          disabled={!editable || !newTag.trim()}
          onClick={async () => {
            const t = newTag.trim();
            if (!t || tags.includes(t)) return;
            await setConfigPath("policy.approvals.require_for_tags", [...tags, t]);
            setNewTag("");
          }}
        >
          add
        </button>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// chat delivery
// ─────────────────────────────────────────────────────────────────────────────

function ChatEditor({
  fullConfig,
  setConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
}): JSX.Element {
  const { models } = useGateway();
  const editable = !!fullConfig?.editable;
  const raw = getPath(fullConfig?.config, ["chat", "delivery"]);
  const delivery = (typeof raw === "string"
    ? { mode: raw }
    : (raw as { mode?: string; max_queued?: number; collapse_duplicates?: boolean }) ?? {}) as {
    mode?: string;
    max_queued?: number;
    collapse_duplicates?: boolean;
  };

  const titleModelRaw = getPath(fullConfig?.config, ["chat", "title_model"]);
  const titleModel = typeof titleModelRaw === "string" ? titleModelRaw : "";
  const autoTitleRaw = getPath(fullConfig?.config, ["chat", "auto_title"]);
  // The schema default is true — treat undefined the same way so the
  // checkbox reflects effective behaviour, not just persisted state.
  const autoTitle = autoTitleRaw === undefined ? true : !!autoTitleRaw;

  return (
    <Card title="chat delivery">
      <div className="hint" style={{ marginBottom: 12 }}>
        controls how messages sent during an active turn are handled. {RESTART_HINT}
      </div>
      <SelectField
        label="mode"
        hint="interrupt: queue and inject at the next LLM turn. queue: wait for the run to fully finish."
        value={delivery.mode ?? "interrupt"}
        options={[
          { value: "interrupt", label: "interrupt (chat-native, default)" },
          { value: "queue", label: "queue (never interrupt)" },
        ]}
        disabled={!editable}
        onChange={(v) => setConfigPath("chat.delivery.mode", v)}
      />
      <NumberField
        label="max_queued"
        hint="cap on pending messages. older messages drop once this fills."
        initial={delivery.max_queued ?? 50}
        min={1}
        max={1000}
        disabled={!editable}
        onSave={(n) => setConfigPath("chat.delivery.max_queued", n)}
      />
      <div className="row gap-2" style={{ alignItems: "center", marginTop: 8 }}>
        <input
          type="checkbox"
          checked={delivery.collapse_duplicates !== false}
          disabled={!editable}
          onChange={(e) => void setConfigPath("chat.delivery.collapse_duplicates", e.target.checked)}
        />
        <span>collapse_duplicates</span>
        <span className="hint" style={{ marginLeft: 8 }}>
          identical queued messages are deduped before delivery.
        </span>
      </div>

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
        <div className="section-label" style={{ marginBottom: 6 }}>auto-title</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          when on, new sessions are named from their first user message. agents
          and users can still override the model per-session.
        </div>
        <div className="row gap-2" style={{ alignItems: "center", marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={autoTitle}
            disabled={!editable}
            onChange={(e) => void setConfigPath("chat.auto_title", e.target.checked)}
          />
          <span>enable auto-title</span>
        </div>
        <SelectField
          label="title_model"
          hint="which model writes the title. main inherits each session's primary model."
          value={titleModel}
          options={[
            { value: "", label: "main (use session model)" },
            ...models.map((m) => ({ value: m.id, label: m.displayName ?? m.id })),
          ]}
          disabled={!editable || !autoTitle}
          onChange={(v) => setConfigPath("chat.title_model", v)}
        />
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// auth tokens
// ─────────────────────────────────────────────────────────────────────────────

interface AuthTokenEntry {
  label: string;
  key?: string;
  key_env?: string;
  scopes?: string[];
}

function AuthTokensEditor({
  fullConfig,
  setConfigPath,
  unsetConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const tokens = (getPath(fullConfig?.config, ["auth", "tokens"]) as AuthTokenEntry[] | undefined) ?? [];
  const [newLabel, setNewLabel] = useState("");

  const addToken = async (): Promise<void> => {
    const label = newLabel.trim();
    if (!label) return;
    const next = [...tokens, { label, scopes: ["*"], key_env: "SQUAD_TOKEN" }];
    await setConfigPath("auth.tokens", next);
    setNewLabel("");
  };

  return (
    <Card title="auth tokens" badge={<span className="tag">{tokens.length}</span>}>
      <div className="hint" style={{ marginBottom: 12 }}>
        bearer tokens accepted by the gateway. each entry has a label and either a literal
        <span className="kbd"> key</span> or an <span className="kbd">key_env</span> reference.
        scopes are method-name globs (<span className="mono">*</span> for everything). {RESTART_HINT}
      </div>
      {tokens.length === 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>
          no tokens — without one, the gateway rejects every websocket connection except
          paired browsers.
        </div>
      )}
      {tokens.map((t, i) => (
        <AuthTokenCard
          key={`${t.label}:${i}`}
          token={t}
          index={i}
          editable={editable}
          setConfigPath={setConfigPath}
          unsetConfigPath={unsetConfigPath}
        />
      ))}
      <div
        className="row gap-2"
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border-soft)",
          alignItems: "center",
        }}
      >
        <span className="section-label">add token</span>
        <input
          className="input"
          placeholder="label (e.g. cli, dashboard)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          style={{ flex: 1 }}
          disabled={!editable}
        />
        <button
          className="btn primary sm"
          disabled={!editable || !newLabel.trim()}
          onClick={() => void addToken()}
        >
          add
        </button>
      </div>
    </Card>
  );
}

function AuthTokenCard({
  token,
  index,
  editable,
  setConfigPath,
  unsetConfigPath,
}: {
  token: AuthTokenEntry;
  index: number;
  editable: boolean;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const base = `auth.tokens.${index}`;
  const scopes = token.scopes ?? ["*"];
  const [newScope, setNewScope] = useState("");
  return (
    <div
      style={{
        marginBottom: 12,
        padding: 12,
        background: "var(--bg-card)",
        border: "1px solid var(--border-soft)",
        borderRadius: 4,
      }}
    >
      <div className="row gap-2" style={{ alignItems: "center", marginBottom: 8 }}>
        <span className="mono strong" style={{ flex: 1 }}>{token.label}</span>
        <span className="tag">{token.key ? "literal" : token.key_env ? `env: ${token.key_env}` : "no secret"}</span>
        <button
          className="btn ghost sm"
          disabled={!editable}
          onClick={() => void unsetConfigPath(base)}
        >
          <Icon name="x" /> remove
        </button>
      </div>
      <Field
        label="label"
        initial={token.label}
        disabled={!editable}
        onSave={(raw) => setConfigPath(`${base}.label`, raw.trim())}
      />
      <Field
        label="key_env"
        hint="env var name on the gateway host. preferred over literal."
        initial={token.key_env}
        placeholder="SQUAD_TOKEN"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") {
            await unsetConfigPath(`${base}.key_env`);
          } else {
            await setConfigPath(`${base}.key_env`, raw.trim());
          }
        }}
        onClear={() => unsetConfigPath(`${base}.key_env`)}
      />
      <Field
        label="key"
        type="password"
        hint="literal secret. lands in config.json — only use for local dev."
        initial={token.key}
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") {
            await unsetConfigPath(`${base}.key`);
          } else {
            await setConfigPath(`${base}.key`, raw);
          }
        }}
        onClear={() => unsetConfigPath(`${base}.key`)}
      />
      <div className="section-label" style={{ marginTop: 8, marginBottom: 4 }}>scopes</div>
      <div className="row gap-1" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        {scopes.map((s) => (
          <span key={s} className="chip">
            {s}
            <button
              className="btn ghost sm"
              style={{ padding: "0 4px", marginLeft: 4 }}
              disabled={!editable}
              onClick={() => void setConfigPath(`${base}.scopes`, scopes.filter((x) => x !== s))}
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="row gap-2">
        <input
          className="input"
          placeholder="scope (e.g. chat.* or admin.*)"
          value={newScope}
          onChange={(e) => setNewScope(e.target.value)}
          style={{ flex: 1 }}
          disabled={!editable}
        />
        <button
          className="btn primary sm"
          disabled={!editable || !newScope.trim()}
          onClick={async () => {
            const s = newScope.trim();
            if (!s || scopes.includes(s)) return;
            await setConfigPath(`${base}.scopes`, [...scopes, s]);
            setNewScope("");
          }}
        >
          add
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// plugins
// ─────────────────────────────────────────────────────────────────────────────

type PluginEntry = string | { path: string; config?: Record<string, unknown> };

function PluginsEditor({
  fullConfig,
  setConfigPath,
  unsetConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const entries = (getPath(fullConfig?.config, ["plugins"]) as PluginEntry[] | undefined) ?? [];
  const [newPath, setNewPath] = useState("");

  return (
    <Card title="plugins" badge={<span className="tag">{entries.length}</span>}>
      <div className="hint" style={{ marginBottom: 12 }}>
        each entry is a node-resolvable specifier or absolute path. plugins ship channels,
        tools, providers, skills, and routines — they all arrive through this list. {RESTART_HINT}
      </div>
      {entries.length === 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>
          no plugins loaded.
        </div>
      )}
      {entries.map((e, i) => {
        const path = typeof e === "string" ? e : e.path;
        const cfg = typeof e === "string" ? {} : (e.config ?? {});
        return (
          <PluginCard
            key={`${path}:${i}`}
            index={i}
            path={path}
            config={cfg}
            editable={editable}
            setConfigPath={setConfigPath}
            unsetConfigPath={unsetConfigPath}
          />
        );
      })}
      <div
        className="row gap-2"
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border-soft)",
          alignItems: "center",
        }}
      >
        <span className="section-label">add plugin</span>
        <input
          className="input"
          placeholder="@squad/channel-discord  |  /abs/path/to/plugin.js"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          style={{ flex: 1 }}
          disabled={!editable}
        />
        <button
          className="btn primary sm"
          disabled={!editable || !newPath.trim()}
          onClick={async () => {
            const p = newPath.trim();
            if (!p) return;
            await setConfigPath("plugins", [...entries, p]);
            setNewPath("");
          }}
        >
          add
        </button>
      </div>
    </Card>
  );
}

function PluginCard({
  index,
  path,
  config,
  editable,
  setConfigPath,
  unsetConfigPath,
}: {
  index: number;
  path: string;
  config: Record<string, unknown>;
  editable: boolean;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const base = `plugins.${index}`;
  const [draftJson, setDraftJson] = useState(JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraftJson(JSON.stringify(config, null, 2)), [config]);

  const save = async (): Promise<void> => {
    try {
      const parsed = draftJson.trim() === "" ? {} : JSON.parse(draftJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config must be a JSON object");
      }
      await setConfigPath(base, { path, config: parsed });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      style={{
        marginBottom: 12,
        padding: 12,
        background: "var(--bg-card)",
        border: "1px solid var(--border-soft)",
        borderRadius: 4,
      }}
    >
      <div className="row gap-2" style={{ alignItems: "center", marginBottom: 8 }}>
        <span className="mono strong" style={{ flex: 1 }}>{path}</span>
        <button
          className="btn ghost sm"
          disabled={!editable}
          onClick={() => void unsetConfigPath(base)}
        >
          <Icon name="x" /> remove
        </button>
      </div>
      <Field
        label="path"
        initial={path}
        disabled={!editable}
        onSave={async (raw) => {
          await setConfigPath(base, { path: raw.trim(), config });
        }}
      />
      <div className="section-label" style={{ marginTop: 8, marginBottom: 4 }}>config (json)</div>
      <textarea
        className="input mono"
        value={draftJson}
        onChange={(e) => setDraftJson(e.target.value)}
        rows={Math.min(10, Math.max(3, draftJson.split("\n").length))}
        disabled={!editable}
        style={{ fontFamily: "var(--font-mono)" }}
      />
      <div className="row gap-2" style={{ marginTop: 6 }}>
        <button className="btn primary sm" onClick={() => void save()} disabled={!editable}>save config</button>
        {error && <span className="tag warn" title={error}>{error}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// server
// ─────────────────────────────────────────────────────────────────────────────

function ServerEditor({
  fullConfig,
  setConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const cfg = (getPath(fullConfig?.config, ["server"]) as
    | {
        host?: string;
        port?: number;
        data_dir?: string;
        workspace_dir?: string;
        memory_dir?: string;
        squad_name?: string;
        build?: string;
      }
    | undefined) ?? {};
  return (
    <Card title="server">
      <div className="hint" style={{ marginBottom: 12 }}>
        bind + filesystem identity. <strong>port</strong> and <strong>host</strong> only take
        effect when the gateway is restarted with the new config — changing them on a running
        instance won't move the listener.
      </div>
      <Field
        label="squad_name"
        hint="how this squad shows up in the manager. matches docker-compose service names."
        initial={cfg.squad_name}
        placeholder="default"
        disabled={!editable}
        onSave={(raw) => setConfigPath("server.squad_name", raw.trim())}
      />
      <Field
        label="host"
        initial={cfg.host}
        placeholder="0.0.0.0"
        disabled={!editable}
        onSave={(raw) => setConfigPath("server.host", raw.trim())}
      />
      <NumberField
        label="port"
        initial={cfg.port}
        min={0}
        max={65535}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.port", n)}
      />
      <Field
        label="data_dir"
        hint="sqlite + pairings.json live here. relative paths resolve against the gateway cwd."
        initial={cfg.data_dir}
        placeholder="./data"
        disabled={!editable}
        onSave={(raw) => setConfigPath("server.data_dir", raw.trim())}
      />
      <Field
        label="workspace_dir"
        hint="agent's home directory — every chat turn runs with this as cwd. empty means <data_dir>/workspace."
        initial={cfg.workspace_dir}
        placeholder="(derive from data_dir)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await setConfigPath("server.workspace_dir", "");
          else await setConfigPath("server.workspace_dir", raw.trim());
        }}
      />
      <Field
        label="memory_dir"
        hint="durable memory store. empty means ${HOME}/.squad/memory; SQUAD_MEMORY_DIR env wins."
        initial={cfg.memory_dir}
        placeholder="(default: ~/.squad/memory)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await setConfigPath("server.memory_dir", "");
          else await setConfigPath("server.memory_dir", raw.trim());
        }}
      />
      <Field
        label="build"
        hint="git sha or version tag, surfaced via admin.identity. empty falls back to the gateway VERSION."
        initial={cfg.build}
        placeholder=""
        disabled={!editable}
        onSave={(raw) => setConfigPath("server.build", raw.trim())}
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// raw config viewer
// ─────────────────────────────────────────────────────────────────────────────

function RawConfigViewer({
  fullConfig,
  refresh,
}: {
  fullConfig: FullConfigState | null;
  refresh: () => Promise<void>;
}): JSX.Element {
  const json = useMemo(() => JSON.stringify(fullConfig?.config ?? {}, null, 2), [fullConfig]);
  return (
    <Card
      title="raw config.json"
      actions={
        <button className="btn ghost sm" onClick={() => void refresh()}>
          reload
        </button>
      }
    >
      <div className="hint" style={{ marginBottom: 8 }}>
        on-disk view, refreshed from <span className="kbd">{fullConfig?.path ?? "(no file)"}</span>.
        edits via the forms above are atomic — the gateway re-validates against the schema before
        each write.
      </div>
      <pre
        className="mono"
        style={{
          background: "var(--bg-inset)",
          color: "var(--fg-muted)",
          padding: 12,
          borderRadius: 3,
          fontSize: "var(--t-sm)",
          whiteSpace: "pre",
          maxHeight: 600,
          overflow: "auto",
        }}
      >
        {json}
      </pre>
    </Card>
  );
}
