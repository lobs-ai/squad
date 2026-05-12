import { useEffect, useMemo, useState } from "react";
import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway, type FullConfigState, type ModelOption } from "../state/GatewayContext.js";
import { fmtAgo } from "../state/fmt.js";
import { usePersistedState } from "../state/usePersistedState.js";

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
  { id: "branding", label: "branding" },
  { id: "providers", label: "providers + keys" },
  { id: "models", label: "models" },
  { id: "subagents", label: "subagents" },
  { id: "approvals", label: "approvals" },
  { id: "chat", label: "chat delivery" },
  { id: "auth", label: "auth tokens" },
  { id: "plugins", label: "plugins" },
  { id: "server", label: "server" },
  { id: "memcore", label: "memcore (memory)" },
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

/**
 * Catalog of well-known providers, surfaced in the "add provider" picker so
 * users can see what they're choosing rather than typing a string and hoping
 * it's spelled right. Mirrors `PROVIDERS` in scripts/setup.mjs — keep in
 * sync when you add a new entry to either file.
 *
 * The gateway accepts arbitrary provider names (custom proxies route through
 * a `base_url` override), so this list is a hint, not a constraint — users
 * can still type a name not in the catalog and the gateway will route it
 * via the openai-compatible adapter.
 *
 * `auth: "oauth-token"` switches the provider card to show an oauth_token
 * field instead of api_key, with provider-specific setup instructions.
 */
interface ProviderCatalogEntry {
  id: string;
  label: string;
  /** "api-key" (default) or "oauth-token". */
  auth: "api-key" | "oauth-token";
  /** Standard env var the gateway reads the secret from. */
  envVar: string;
  /** Page or command where the user obtains the secret. */
  keyUrl: string;
  /** Short one-liner shown in pickers. */
  description?: string;
  /**
   * Multi-line instructions for oauth-token providers — e.g. the exact
   * command to run to mint a token.
   */
  setupInstructions?: string;
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "anthropic", label: "Anthropic (Claude)", auth: "api-key", envVar: "ANTHROPIC_API_KEY", keyUrl: "https://console.anthropic.com" },
  {
    id: "claude-cli",
    label: "Claude Code CLI (Anthropic via OAuth)",
    auth: "oauth-token",
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    keyUrl: "run `claude setup-token` locally",
    description: "use your Claude.ai subscription — no API key required",
    setupInstructions:
      "run `claude setup-token` on a machine with browser access, log in to your Claude.ai account, then paste the token below.",
  },
  { id: "openai", label: "OpenAI (GPT)", auth: "api-key", envVar: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "openrouter", label: "OpenRouter", auth: "api-key", envVar: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys", description: "~24 providers via one key" },
  { id: "google", label: "Google (Gemini)", auth: "api-key", envVar: "GOOGLE_API_KEY", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "groq", label: "Groq", auth: "api-key", envVar: "GROQ_API_KEY", keyUrl: "https://console.groq.com/keys", description: "very fast inference" },
  { id: "deepseek", label: "DeepSeek", auth: "api-key", envVar: "DEEPSEEK_API_KEY", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "xai", label: "xAI (Grok)", auth: "api-key", envVar: "XAI_API_KEY", keyUrl: "https://console.x.ai" },
  { id: "mistral", label: "Mistral", auth: "api-key", envVar: "MISTRAL_API_KEY", keyUrl: "https://console.mistral.ai/api-keys/" },
  { id: "together", label: "Together.ai", auth: "api-key", envVar: "TOGETHER_API_KEY", keyUrl: "https://api.together.ai/settings/api-keys", description: "open-weight models" },
  { id: "perplexity", label: "Perplexity", auth: "api-key", envVar: "PPLX_API_KEY", keyUrl: "https://www.perplexity.ai/settings/api" },
  { id: "fireworks", label: "Fireworks", auth: "api-key", envVar: "FIREWORKS_API_KEY", keyUrl: "https://fireworks.ai/account/api-keys" },
  { id: "cerebras", label: "Cerebras", auth: "api-key", envVar: "CEREBRAS_API_KEY", keyUrl: "https://cloud.cerebras.ai", description: "very fast inference" },
  { id: "cohere", label: "Cohere", auth: "api-key", envVar: "COHERE_API_KEY", keyUrl: "https://dashboard.cohere.com/api-keys" },
  { id: "minimax", label: "MiniMax", auth: "api-key", envVar: "MINIMAX_API_KEY", keyUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key" },
  { id: "ollama", label: "Ollama (local)", auth: "api-key", envVar: "OLLAMA_API_KEY", keyUrl: "http://localhost:11434 — no key needed; set base_url instead", description: "self-hosted; configure base_url" },
];

const PROVIDER_CATALOG_BY_ID = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]));

export function Settings({ theme, setTheme, density, setDensity, accent, setAccent }: Props): JSX.Element {
  const [sectionRaw, setSectionRaw] = usePersistedState("squad-settings-section", "squad");
  const section = (SECTIONS.some((s) => s.id === sectionRaw) ? sectionRaw : "squad") as (typeof SECTIONS)[number]["id"];
  const setSection = setSectionRaw as (v: (typeof SECTIONS)[number]["id"]) => void;
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

          {section === "branding" && (
            <BrandingEditor fullConfig={fullConfig} setConfigPath={setConfigPath} />
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
              models={models}
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

          {section === "memcore" && (
            <MemCoreEditor
              fullConfig={fullConfig}
              setConfigPath={setConfigPath}
              unsetConfigPath={unsetConfigPath}
            />
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

  const [selectedToAdd, setSelectedToAdd] = useState("");
  const [customProvider, setCustomProvider] = useState("");

  const addCatalogProvider = async (id: string): Promise<void> => {
    if (!id || providers[id]) return;
    const spec = PROVIDER_CATALOG_BY_ID.get(id);
    if (!spec) return;
    const entry =
      spec.auth === "oauth-token"
        ? { oauth_token_env: spec.envVar }
        : { api_key_env: spec.envVar };
    await setConfigPath(`llm.providers.${id}`, entry);
    setSelectedToAdd("");
  };

  const addCustomProvider = async (name: string): Promise<void> => {
    const cleaned = name.trim();
    if (!cleaned || providers[cleaned]) return;
    await setConfigPath(`llm.providers.${cleaned}`, { api_key_env: defaultEnvFor(cleaned) });
    setCustomProvider("");
  };

  const available = PROVIDER_CATALOG.filter((p) => !providers[p.id]);

  return (
    <Card
      title="providers"
      badge={<span className="tag">{names.length}</span>}
    >
      <div className="hint" style={{ marginBottom: 12 }}>
        every provider needs a credential — usually an api key, occasionally an oauth token.
        pick from the catalog below or add a custom one. {RESTART_HINT}
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
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border-soft)",
        }}
      >
        <div className="section-label" style={{ marginBottom: 6 }}>add from catalog</div>
        <div className="row gap-2" style={{ alignItems: "center", marginBottom: 6 }}>
          <select
            className="input"
            value={selectedToAdd}
            onChange={(e) => setSelectedToAdd(e.target.value)}
            disabled={!editable || available.length === 0}
            style={{ flex: 1 }}
          >
            <option value="">
              {available.length === 0 ? "all catalog providers added" : "choose a provider…"}
            </option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.auth === "oauth-token" ? "  [OAuth]" : ""}
                {p.description ? `  — ${p.description}` : ""}
              </option>
            ))}
          </select>
          <button
            className="btn primary sm"
            onClick={() => void addCatalogProvider(selectedToAdd)}
            disabled={!editable || !selectedToAdd}
          >
            add
          </button>
        </div>
        <div className="hint" style={{ fontSize: "var(--t-sm)", marginBottom: 12 }}>
          can't find your provider? add it manually:
        </div>
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <input
            className="input"
            placeholder="custom provider id (e.g. minimax)"
            value={customProvider}
            onChange={(e) => setCustomProvider(e.target.value)}
            style={{ flex: 1 }}
            disabled={!editable}
          />
          <button
            className="btn ghost sm"
            onClick={() => void addCustomProvider(customProvider)}
            disabled={!editable || !customProvider.trim()}
          >
            add custom
          </button>
        </div>
      </div>
    </Card>
  );
}

interface ProviderEntry {
  api_key?: string;
  api_key_env?: string;
  oauth_token?: string;
  oauth_token_env?: string;
  base_url?: string;
}

function defaultEnvFor(name: string): string {
  const cataloged = PROVIDER_CATALOG_BY_ID.get(name);
  if (cataloged) return cataloged.envVar;
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
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
  const spec = PROVIDER_CATALOG_BY_ID.get(name);
  const usesOAuth = spec?.auth === "oauth-token";

  const statusTag = usesOAuth
    ? entry.oauth_token
      ? "literal token"
      : entry.oauth_token_env
        ? `env: ${entry.oauth_token_env}`
        : "no token"
    : entry.api_key
      ? "literal key"
      : entry.api_key_env
        ? `env: ${entry.api_key_env}`
        : "no key";

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
      <div className="row gap-2" style={{ alignItems: "center", marginBottom: 4 }}>
        <span className="mono strong" style={{ flex: 1 }}>{name}</span>
        {usesOAuth && <span className="tag">OAuth</span>}
        <span className="tag">{statusTag}</span>
        <button
          className="btn ghost sm"
          onClick={() => void unsetConfigPath(base)}
          disabled={!editable}
          title="remove this provider entirely"
        >
          <Icon name="x" /> remove
        </button>
      </div>
      {spec && (
        <div className="hint" style={{ marginBottom: 8, fontSize: "var(--t-sm)" }}>
          {spec.label}
          {spec.description ? ` — ${spec.description}` : ""}
          <span style={{ display: "block", marginTop: 2 }}>
            <span className="faint">key from: </span>
            <span className="mono">{spec.keyUrl}</span>
          </span>
          {usesOAuth && spec.setupInstructions && (
            <span style={{ display: "block", marginTop: 4 }}>{spec.setupInstructions}</span>
          )}
        </div>
      )}
      {usesOAuth ? (
        <>
          <Field
            label="oauth_token_env"
            hint="env var name on the gateway host that holds the long-lived OAuth token."
            initial={entry.oauth_token_env}
            placeholder={spec?.envVar ?? "CLAUDE_CODE_OAUTH_TOKEN"}
            disabled={!editable}
            onSave={async (raw) => {
              if (raw.trim() === "") {
                await unsetConfigPath(`${base}.oauth_token_env`);
              } else {
                await setConfigPath(`${base}.oauth_token_env`, raw.trim());
              }
            }}
            onClear={() => unsetConfigPath(`${base}.oauth_token_env`)}
          />
          <Field
            label="oauth_token"
            hint="literal oauth token. avoid when possible — prefer oauth_token_env so the secret stays out of config.json."
            type="password"
            initial={entry.oauth_token}
            placeholder="paste long-lived token from `claude setup-token`"
            disabled={!editable}
            onSave={async (raw) => {
              if (raw.trim() === "") {
                await unsetConfigPath(`${base}.oauth_token`);
              } else {
                await setConfigPath(`${base}.oauth_token`, raw);
              }
            }}
            onClear={() => unsetConfigPath(`${base}.oauth_token`)}
          />
        </>
      ) : (
        <>
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
        </>
      )}
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

function fmtContextWindow(n: number): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function groupModelsByProvider(models: ModelOption[]): Array<[string, ModelOption[]]> {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const arr = groups.get(m.provider) ?? [];
    arr.push(m);
    groups.set(m.provider, arr);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Picker that returns a model id, sourced from the gateway's `admin.models`
 * list (grouped by provider) plus a "custom id…" escape hatch for models the
 * catalog doesn't know about.
 */
function ModelPicker({
  models,
  excluded,
  disabled,
  buttonLabel,
  onPick,
}: {
  models: ModelOption[];
  excluded?: Set<string>;
  disabled: boolean;
  buttonLabel: string;
  onPick: (id: string) => void;
}): JSX.Element {
  const [selected, setSelected] = useState("");
  const [custom, setCustom] = useState("");
  const visible = models.filter((m) => !excluded?.has(m.id));
  const grouped = groupModelsByProvider(visible);

  const submit = (): void => {
    const id = (selected === "__custom__" ? custom.trim() : selected.trim());
    if (!id) return;
    onPick(id);
    setSelected("");
    setCustom("");
  };

  return (
    <div className="row gap-2" style={{ alignItems: "center" }}>
      <select
        className="input"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        disabled={disabled}
        style={{ flex: 1 }}
      >
        <option value="">
          {visible.length === 0 ? "no models available — wire a provider first" : "choose a model…"}
        </option>
        {grouped.map(([provider, list]) => (
          <optgroup key={provider} label={provider}>
            {list.map((m) => {
              const ctx = fmtContextWindow(m.contextWindow);
              const suffix = [
                ctx !== "—" ? `${ctx} ctx` : null,
                m.notes ? m.notes : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                  {suffix ? `  (${suffix})` : ""}
                </option>
              );
            })}
          </optgroup>
        ))}
        <option value="__custom__">custom model id…</option>
      </select>
      {selected === "__custom__" && (
        <input
          className="input mono"
          placeholder="provider/model-id"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={disabled}
          style={{ flex: 1 }}
        />
      )}
      <button
        className="btn primary sm"
        onClick={submit}
        disabled={
          disabled ||
          !selected ||
          (selected === "__custom__" && !custom.trim())
        }
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function ModelsEditor({
  fullConfig,
  setConfigPath,
  unsetConfigPath: _unsetConfigPath,
  models,
  configuredPrimary,
  configuredFallbacks,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
  models: ModelOption[];
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

  const modelsById = new Map(models.map((m) => [m.id, m]));
  const grouped = groupModelsByProvider(models);

  const describe = (id: string): { displayName: string; provider: string; ctx: string; notes?: string } => {
    const found = modelsById.get(id);
    if (found) {
      return {
        displayName: found.displayName,
        provider: found.provider,
        ctx: fmtContextWindow(found.contextWindow),
        notes: found.notes,
      };
    }
    const slash = id.indexOf("/");
    return {
      displayName: slash > 0 ? id.slice(slash + 1) : id,
      provider: slash > 0 ? id.slice(0, slash) : "unknown",
      ctx: "—",
      notes: "not in catalog",
    };
  };

  const setPrimary = async (id: string): Promise<void> => {
    await setConfigPath("llm.primary", { model: id });
  };
  const addFallback = async (id: string): Promise<void> => {
    if (fallbacks.includes(id) || id === primary) return;
    const next = [...fallbacks, id];
    await setConfigPath("llm.fallbacks", next.map((x) => ({ model: x })));
  };

  const fallbackExcluded = new Set<string>([primary, ...fallbacks].filter(Boolean));

  return (
    <Card title="models" badge={<span className="tag">{models.length} available</span>}>
      <div className="hint" style={{ marginBottom: 12 }}>
        the runner tries <strong>primary</strong> first; on a fallback-eligible failure (rate
        limit, 5xx, timeout) it advances to the next entry and stays there for the rest of the
        session. {RESTART_HINT}
      </div>

      <div className="section-label" style={{ marginBottom: 6 }}>primary</div>
      {primary ? (
        <div
          className="row gap-2"
          style={{
            padding: "10px 12px",
            background: "var(--bg-card)",
            border: "1px solid var(--border-soft)",
            borderRadius: 4,
            marginBottom: 8,
            alignItems: "center",
          }}
        >
          <span className="mono strong" style={{ flex: 1 }}>{primary}</span>
          {(() => {
            const d = describe(primary);
            return (
              <>
                <span className="tag">{d.provider}</span>
                <span className="hint" style={{ fontSize: "var(--t-sm)" }}>
                  {d.displayName} · {d.ctx} ctx{d.notes ? ` · ${d.notes}` : ""}
                </span>
              </>
            );
          })()}
        </div>
      ) : (
        <div className="hint" style={{ marginBottom: 8 }}>
          no primary model set — pick one below to enable agent runs.
        </div>
      )}
      <ModelPicker
        models={models}
        disabled={!editable}
        buttonLabel="set primary"
        onPick={(id) => void setPrimary(id)}
      />

      <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
        fallbacks
      </div>
      {effective.length === 0 && (
        <div className="hint" style={{ marginBottom: 8 }}>
          no fallbacks — primary failures bubble up.
        </div>
      )}
      <div className="row-list" style={{ marginBottom: 8 }}>
        {fallbacks.map((m, i) => {
          const d = describe(m);
          return (
            <div key={`${m}:${i}`} className="row gap-2" style={{ padding: "6px 0", alignItems: "center" }}>
              <span className="faint" style={{ width: 24 }}>{i + 1}.</span>
              <span className="mono" style={{ minWidth: 0, flex: 1 }}>{m}</span>
              <span className="tag">{d.provider}</span>
              <span className="hint" style={{ fontSize: "var(--t-sm)", width: 180, textAlign: "right" }}>
                {d.ctx} ctx{d.notes ? ` · ${d.notes}` : ""}
              </span>
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
          );
        })}
      </div>
      <ModelPicker
        models={models}
        excluded={fallbackExcluded}
        disabled={!editable}
        buttonLabel="add fallback"
        onPick={(id) => void addFallback(id)}
      />

      <div className="section-label" style={{ marginTop: 20, marginBottom: 6 }}>
        all available models
      </div>
      <div className="hint" style={{ marginBottom: 6 }}>
        models the gateway can currently route — the catalog filtered to providers you've
        configured, plus your primary + fallbacks.
      </div>
      {grouped.length === 0 && <div className="hint">no models — wire a provider first.</div>}
      {grouped.map(([provider, list]) => (
        <div key={provider} style={{ marginBottom: 12 }}>
          <div
            className="row gap-2"
            style={{ alignItems: "center", marginBottom: 4 }}
          >
            <span className="section-label">{provider}</span>
            <span className="tag">{list.length}</span>
          </div>
          {list.map((m) => (
            <div
              key={m.id}
              className="row gap-2"
              style={{
                padding: "4px 0",
                fontSize: "var(--t-sm)",
                alignItems: "center",
              }}
            >
              <span className="mono" style={{ flex: 1 }}>{m.id}</span>
              <span className="faint" style={{ width: 220 }}>{m.displayName}</span>
              <span className="faint mono" style={{ width: 70, textAlign: "right" }}>
                {fmtContextWindow(m.contextWindow)} ctx
              </span>
              <span className="faint" style={{ width: 160, textAlign: "right" }}>
                {m.notes ?? ""}
              </span>
            </div>
          ))}
        </div>
      ))}
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

// Short, plain-English descriptions for the well-known tags emitted by the
// built-in tools. Anything not listed here still works — it just renders
// without a description and counts as a "custom" tag.
const TAG_DESCRIPTIONS: Record<string, string> = {
  write: "modifies files or persistent state",
  exec: "runs a shell command",
  network: "makes outbound network requests",
  shell: "spawns shell processes (Bash, exec)",
  filesystem: "touches the local filesystem",
  readonly: "reads only — no side effects",
  search: "searches files or the web",
  directory: "lists or walks directories",
  web: "uses the open internet",
  fetch: "fetches a URL",
  config: "reads or writes gateway config",
  meta: "introspects tools or groups",
  subagent: "spawns or talks to subagents",
  restart: "restarts the gateway",
  dangerous: "explicitly marked dangerous",
  pdf: "generates or edits PDFs",
  pptx: "generates or edits slide decks",
  html: "renders or edits HTML",
};

interface ToolCatalogEntry {
  name: string;
  description: string;
  tags: string[];
}

function ApprovalsEditor({
  fullConfig,
  setConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
}): JSX.Element {
  const { client } = useGateway();
  const editable = !!fullConfig?.editable;
  const cfg = (getPath(fullConfig?.config, ["policy", "approvals"]) as
    | {
        default?: "tag-match" | "allow-all" | "deny-all";
        require_for_tags?: string[];
        require_for_tools?: string[];
        timeout_seconds?: number;
      }
    | undefined) ?? {};
  const selectedTags = cfg.require_for_tags ?? ["write", "exec", "network"];
  const selectedTools = cfg.require_for_tools ?? [];
  const defaultPolicy = cfg.default ?? "tag-match";
  const tagMatchActive = defaultPolicy === "tag-match";

  const [catalog, setCatalog] = useState<ToolCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const [customTag, setCustomTag] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await client.request("admin.tools.catalog", {});
        if (!cancelled) setCatalog(r.tools as ToolCatalogEntry[]);
      } catch (err) {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : String(err));
          setCatalog([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Derive the set of tags that actually exist on at least one registered
  // tool — these are the ones we render as first-class chips. Any tag in
  // `selectedTags` that isn't in the catalog is rendered as "custom".
  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of catalog ?? []) for (const tag of t.tags) set.add(tag);
    // Always surface the documented ones even if a tool with that tag isn't
    // currently loaded — keeps the picker stable across plugin reloads.
    for (const t of Object.keys(TAG_DESCRIPTIONS)) set.add(t);
    return Array.from(set).sort();
  }, [catalog]);

  const tagToolCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of catalog ?? []) {
      for (const tag of t.tags) m.set(tag, (m.get(tag) ?? 0) + 1);
    }
    return m;
  }, [catalog]);

  const customSelectedTags = useMemo(
    () => selectedTags.filter((t) => !knownTags.includes(t)),
    [selectedTags, knownTags],
  );

  // Effective "will prompt" set: every tool whose tag is in selectedTags
  // OR whose name is in selectedTools. Drives the impact preview at the top.
  const willPrompt = useMemo(() => {
    if (defaultPolicy === "allow-all") return new Set<string>();
    if (defaultPolicy === "deny-all") return new Set((catalog ?? []).map((t) => t.name));
    const tags = new Set(selectedTags);
    const tools = new Set(selectedTools);
    const out = new Set<string>();
    for (const t of catalog ?? []) {
      if (tools.has(t.name)) out.add(t.name);
      else if (t.tags.some((x) => tags.has(x))) out.add(t.name);
    }
    return out;
  }, [catalog, defaultPolicy, selectedTags, selectedTools]);

  const filteredTools = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    const all = catalog ?? [];
    if (!q) return all;
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [catalog, toolQuery]);

  const toggleTag = async (tag: string): Promise<void> => {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((t) => t !== tag)
      : [...selectedTags, tag];
    await setConfigPath("policy.approvals.require_for_tags", next);
  };

  const toggleTool = async (name: string): Promise<void> => {
    const next = selectedTools.includes(name)
      ? selectedTools.filter((t) => t !== name)
      : [...selectedTools, name];
    await setConfigPath("policy.approvals.require_for_tools", next);
  };

  return (
    <Card title="approvals">
      <div className="hint" style={{ marginBottom: 12 }}>
        Decide which tools pause for your approval before running. {LIVE_HINT}
      </div>

      <SelectField
        label="default policy"
        hint="tag-match: only the tags / tools you pick below pause. allow-all auto-approves every call. deny-all blocks every call."
        value={defaultPolicy}
        options={[
          { value: "tag-match", label: "tag-match — prompt only for selected tags / tools" },
          { value: "allow-all", label: "allow-all — auto-approve everything" },
          { value: "deny-all", label: "deny-all — block everything" },
        ]}
        disabled={!editable}
        onChange={(v) => setConfigPath("policy.approvals.default", v)}
      />

      <NumberField
        label="approval timeout (seconds)"
        hint="how long the agent waits for an answer before treating no-response as a denial."
        initial={cfg.timeout_seconds}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("policy.approvals.timeout_seconds", n)}
      />

      {!tagMatchActive && (
        <div
          style={{
            marginTop: 12,
            padding: "8px 10px",
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-line)",
            borderRadius: 4,
            fontSize: "var(--t-xs)",
            color: "var(--fg)",
          }}
        >
          The default policy is <strong>{defaultPolicy}</strong>, so the tag and tool selections
          below are saved but not applied. Switch to <code>tag-match</code> to use them.
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          padding: "8px 10px",
          background: "var(--bg-inset)",
          border: "1px solid var(--border-soft)",
          borderRadius: 4,
          fontSize: "var(--t-xs)",
          color: "var(--fg-muted)",
        }}
      >
        {catalog === null
          ? "loading tool catalog…"
          : catalog.length === 0
            ? "no registered tools were reported by the gateway."
            : (
              <>
                <strong style={{ color: "var(--fg)" }}>{willPrompt.size}</strong> of{" "}
                {catalog.length} registered tools will prompt for approval.
              </>
            )}
      </div>

          <div className="section-label" style={{ marginTop: 16, marginBottom: 4 }}>
            require approval by tag
          </div>
          <div className="hint" style={{ marginBottom: 8 }}>
            Click a tag to require approval for every tool that carries it. Tap again to remove.
          </div>
          <div className="col gap-1" style={{ marginBottom: 10 }}>
            {knownTags.map((tag) => {
              const on = selectedTags.includes(tag);
              const count = tagToolCount.get(tag) ?? 0;
              const desc = TAG_DESCRIPTIONS[tag];
              return (
                <button
                  key={tag}
                  className="btn"
                  type="button"
                  disabled={!editable}
                  onClick={() => void toggleTag(tag)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 10px",
                    textAlign: "left",
                    borderColor: on ? "var(--accent-line)" : undefined,
                    background: on ? "var(--accent-soft)" : undefined,
                    color: on ? "var(--accent)" : undefined,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name={on ? "check" : "circle"} size={12} />
                    <span style={{ fontWeight: 600 }}>{tag}</span>
                    {desc && (
                      <span className="hint" style={{ marginLeft: 4 }}>
                        — {desc}
                      </span>
                    )}
                  </span>
                  <span className="hint" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {count} {count === 1 ? "tool" : "tools"}
                  </span>
                </button>
              );
            })}
          </div>

          {customSelectedTags.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="hint" style={{ marginBottom: 4 }}>
                custom tags currently set:
              </div>
              <div className="row gap-1" style={{ flexWrap: "wrap" }}>
                {customSelectedTags.map((t) => (
                  <span key={t} className="chip on">
                    {t}
                    <button
                      className="btn ghost sm"
                      style={{ padding: "0 4px", marginLeft: 4 }}
                      disabled={!editable}
                      onClick={() => void toggleTag(t)}
                      aria-label={`remove tag ${t}`}
                    >
                      <Icon name="x" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="row gap-2" style={{ marginBottom: 16 }}>
            <input
              className="input"
              placeholder="add a custom tag (rare — only if a plugin defines one)"
              value={customTag}
              onChange={(e) => setCustomTag(e.target.value)}
              style={{ flex: 1 }}
              disabled={!editable}
            />
            <button
              className="btn sm"
              disabled={!editable || !customTag.trim()}
              onClick={async () => {
                const t = customTag.trim();
                if (!t || selectedTags.includes(t)) {
                  setCustomTag("");
                  return;
                }
                await setConfigPath("policy.approvals.require_for_tags", [...selectedTags, t]);
                setCustomTag("");
              }}
            >
              add tag
            </button>
          </div>

          <div className="section-label" style={{ marginTop: 8, marginBottom: 4 }}>
            require approval for specific tools
          </div>
          <div className="hint" style={{ marginBottom: 8 }}>
            Pick individual tools that should always pause — independent of tags. Useful when you
            want, say, only <code>Bash</code> to prompt without gating everything tagged{" "}
            <code>exec</code>.
          </div>

          {selectedTools.length > 0 && (
            <div className="row gap-1" style={{ flexWrap: "wrap", marginBottom: 8 }}>
              {selectedTools.map((name) => (
                <span key={name} className="chip on">
                  {name}
                  <button
                    className="btn ghost sm"
                    style={{ padding: "0 4px", marginLeft: 4 }}
                    disabled={!editable}
                    onClick={() => void toggleTool(name)}
                    aria-label={`remove tool ${name}`}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            className="input"
            placeholder={
              catalog && catalog.length > 0
                ? `search ${catalog.length} tools by name, description, or tag…`
                : "search tools…"
            }
            value={toolQuery}
            onChange={(e) => setToolQuery(e.target.value)}
            disabled={!editable || !catalog || catalog.length === 0}
            style={{ marginBottom: 6 }}
          />

          {catalogError && (
            <div className="hint" style={{ color: "var(--danger)", marginBottom: 6 }}>
              couldn't load tool catalog: {catalogError}
            </div>
          )}

          <div
            style={{
              maxHeight: 280,
              overflowY: "auto",
              border: "1px solid var(--border-soft)",
              borderRadius: 4,
              background: "var(--bg-inset)",
            }}
          >
            {catalog === null ? (
              <div className="hint" style={{ padding: 10 }}>
                loading…
              </div>
            ) : filteredTools.length === 0 ? (
              <div className="hint" style={{ padding: 10 }}>
                {toolQuery ? `no tools match "${toolQuery}".` : "no tools registered."}
              </div>
            ) : (
              filteredTools.map((tool) => {
                const onTool = selectedTools.includes(tool.name);
                const onByTag = tool.tags.some((tag) => selectedTags.includes(tag));
                const willGate = onTool || onByTag;
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => void toggleTool(tool.name)}
                    disabled={!editable}
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 10px",
                      textAlign: "left",
                      background: onTool ? "var(--accent-soft)" : "transparent",
                      borderTop: "1px solid var(--border-soft)",
                      borderLeft: "none",
                      borderRight: "none",
                      borderBottom: "none",
                      cursor: editable ? "pointer" : "default",
                      color: "var(--fg)",
                    }}
                  >
                    <Icon
                      name={onTool || willGate ? "check" : "circle"}
                      size={14}
                      style={{ color: onTool ? "var(--accent)" : "var(--fg-muted)", marginTop: 2 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600 }}>{tool.name}</span>
                        {tool.tags.map((tag) => (
                          <span
                            key={tag}
                            className={selectedTags.includes(tag) ? "chip on" : "chip"}
                            style={{ padding: "0 5px" }}
                          >
                            {tag}
                          </span>
                        ))}
                        {willGate && !onTool && (
                          <span className="hint" style={{ fontSize: "var(--t-xs)" }}>
                            (already gated by tag)
                          </span>
                        )}
                      </div>
                      {tool.description && (
                        <div
                          className="hint"
                          style={{
                            marginTop: 2,
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {tool.description}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// chat delivery
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// branding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edits `branding.{agent_name, user_name}` — the display labels every UI
 * surface (dashboard, CLI, channels) reads via `admin.identity.branding`.
 * Saves apply live to the dashboard on the next `admin.identity` refresh;
 * the agent can write the same paths through `admin.config.set`, so either
 * side can rebrand. Subagents aren't surfaced here because they're spawned
 * ad-hoc per task — there's no single name to give them.
 */
function BrandingEditor({
  fullConfig,
  setConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const agentName = (getPath(fullConfig?.config, ["branding", "agent_name"]) as string | undefined) ?? "";
  const userName = (getPath(fullConfig?.config, ["branding", "user_name"]) as string | undefined) ?? "";

  return (
    <Card title="branding">
      <div className="hint" style={{ marginBottom: 12 }}>
        display labels surfaced everywhere — chat speaker tags, owner badges,
        CLI prompt, status bar. internal role enums (<span className="kbd">user</span>,{" "}
        <span className="kbd">agent</span>) are unchanged. blank inherits the generic default.
      </div>
      <Field
        label="agent_name"
        hint='shown wherever the assistant speaks — chat label, "agent turn", typing indicator. e.g. "Squad", "Jarvis".'
        initial={agentName}
        placeholder="agent"
        disabled={!editable}
        onSave={(v) => setConfigPath("branding.agent_name", v)}
      />
      <Field
        label="user_name"
        hint='your speaker label in chat and "needs you" cards. e.g. your first name.'
        initial={userName}
        placeholder="you"
        disabled={!editable}
        onSave={(v) => setConfigPath("branding.user_name", v)}
      />
    </Card>
  );
}

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
  const titleFallbackRaw = getPath(fullConfig?.config, ["chat", "title_fallback_model"]);
  const titleFallback = typeof titleFallbackRaw === "string" ? titleFallbackRaw : "";
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
          when on, new sessions are named from their first user message.
          changes apply live — no restart needed. agents and users can still
          override the model per-session.
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
        <SelectField
          label="title_fallback_model"
          hint="used when the chosen title model fails (e.g. typo'd or retired). main uses the gateway primary."
          value={titleFallback}
          options={[
            { value: "", label: "main (gateway primary)" },
            ...models.map((m) => ({ value: m.id, label: m.displayName ?? m.id })),
          ]}
          disabled={!editable || !autoTitle}
          onChange={(v) => setConfigPath("chat.title_fallback_model", v)}
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
// memcore (memory)
// ─────────────────────────────────────────────────────────────────────────────

interface MemCoreCfg {
  database_url?: string;
  container_tag?: string;
  embedding_api_key_env?: string;
  embedding_base_url?: string;
  embedding_model?: string;
  embedding_dim?: number;
  processing_model?: string;
  extraction_model?: string;
  contextualizer_model?: string;
  conflict_model?: string;
  temporal_parser_model?: string;
  profile_generator_model?: string;
  ingest?: {
    idle_threshold_seconds?: number;
    max_idle_seconds?: number;
    min_delta_messages?: number;
    min_delta_tokens?: number;
    include_subagents?: boolean;
    sweeper_interval_seconds?: number;
  };
}

function MemCoreEditor({
  fullConfig,
  setConfigPath,
  unsetConfigPath,
}: {
  fullConfig: FullConfigState | null;
  setConfigPath: (p: string, v: unknown) => Promise<void>;
  unsetConfigPath: (p: string) => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const cfg = (getPath(fullConfig?.config, ["server", "memcore"]) as MemCoreCfg | undefined) ?? {};
  const ingest = cfg.ingest ?? {};
  const stageHint =
    "empty inherits the stage default → server.memcore.processing_model → llm.primary.model.";

  return (
    <Card title="memcore (memory)">
      <div className="hint" style={{ marginBottom: 12 }}>
        memcore is the durable memory backend. {RESTART_HINT} an unset
        <span className="kbd"> database_url</span> + missing{" "}
        <span className="kbd">MEMCORE_DATABASE_URL</span> env var will fail boot.
      </div>
      <Field
        label="database_url"
        hint="postgres connection string. falls back to MEMCORE_DATABASE_URL env var."
        initial={cfg.database_url}
        placeholder="postgres://user:pass@host:5432/memcore"
        type="password"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.database_url");
          else await setConfigPath("server.memcore.database_url", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.database_url")}
      />
      <Field
        label="container_tag"
        hint="multi-tenant scope. empty derives from server.squad_name — only override to share memory between squads."
        initial={cfg.container_tag}
        placeholder="(derive from squad_name)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.container_tag");
          else await setConfigPath("server.memcore.container_tag", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.container_tag")}
      />

      <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
        embeddings
      </div>
      <Field
        label="embedding_api_key_env"
        hint="env var holding the embedder's api key. defaults to OPENAI_API_KEY."
        initial={cfg.embedding_api_key_env}
        placeholder="OPENAI_API_KEY"
        disabled={!editable}
        onSave={(raw) => setConfigPath("server.memcore.embedding_api_key_env", raw.trim())}
      />
      <Field
        label="embedding_base_url"
        hint="optional. proxy / on-prem embedder endpoint. empty = OpenAI."
        initial={cfg.embedding_base_url}
        placeholder="(default: OpenAI)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.embedding_base_url");
          else await setConfigPath("server.memcore.embedding_base_url", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.embedding_base_url")}
      />
      <Field
        label="embedding_model"
        initial={cfg.embedding_model}
        placeholder="text-embedding-3-large"
        disabled={!editable}
        onSave={(raw) => setConfigPath("server.memcore.embedding_model", raw.trim())}
      />
      <NumberField
        label="embedding_dim"
        hint="only relevant when overriding the model. must match the model's native dimension."
        initial={cfg.embedding_dim}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.memcore.embedding_dim", n)}
      />

      <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
        processing models
      </div>
      <Field
        label="processing_model"
        hint="default model for every memcore stage. empty inherits llm.primary.model."
        initial={cfg.processing_model}
        placeholder="(inherit llm.primary)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.processing_model");
          else await setConfigPath("server.memcore.processing_model", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.processing_model")}
      />
      <Field
        label="extraction_model"
        hint={stageHint}
        initial={cfg.extraction_model}
        placeholder="(inherit processing_model)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.extraction_model");
          else await setConfigPath("server.memcore.extraction_model", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.extraction_model")}
      />
      <Field
        label="contextualizer_model"
        hint={stageHint}
        initial={cfg.contextualizer_model}
        placeholder="(inherit processing_model)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.contextualizer_model");
          else await setConfigPath("server.memcore.contextualizer_model", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.contextualizer_model")}
      />
      <Field
        label="conflict_model"
        hint={stageHint}
        initial={cfg.conflict_model}
        placeholder="(inherit processing_model)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.conflict_model");
          else await setConfigPath("server.memcore.conflict_model", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.conflict_model")}
      />
      <Field
        label="temporal_parser_model"
        hint={stageHint}
        initial={cfg.temporal_parser_model}
        placeholder="(inherit processing_model)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.temporal_parser_model");
          else await setConfigPath("server.memcore.temporal_parser_model", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.temporal_parser_model")}
      />
      <Field
        label="profile_generator_model"
        hint={stageHint}
        initial={cfg.profile_generator_model}
        placeholder="(inherit processing_model)"
        disabled={!editable}
        onSave={async (raw) => {
          if (raw.trim() === "") await unsetConfigPath("server.memcore.profile_generator_model");
          else await setConfigPath("server.memcore.profile_generator_model", raw.trim());
        }}
        onClear={() => unsetConfigPath("server.memcore.profile_generator_model")}
      />

      <div className="section-label" style={{ marginTop: 16, marginBottom: 6 }}>
        idle ingestion
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        a sweeper picks sessions that have gone quiet and feeds the unprocessed delta into
        memcore's extraction pipeline. tune for cost vs. recall.
      </div>
      <NumberField
        label="idle_threshold_seconds"
        hint="seconds of inactivity before a session is eligible for ingestion."
        initial={ingest.idle_threshold_seconds}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.memcore.ingest.idle_threshold_seconds", n)}
      />
      <NumberField
        label="max_idle_seconds"
        hint="hard ceiling — force-ingest once unprocessed content is older than this."
        initial={ingest.max_idle_seconds}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.memcore.ingest.max_idle_seconds", n)}
      />
      <NumberField
        label="min_delta_messages"
        hint="skip ingestion when the unprocessed delta is smaller than this."
        initial={ingest.min_delta_messages}
        min={0}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.memcore.ingest.min_delta_messages", n)}
      />
      <NumberField
        label="min_delta_tokens"
        hint="token-budget gate, same role as min_delta_messages."
        initial={ingest.min_delta_tokens}
        min={0}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.memcore.ingest.min_delta_tokens", n)}
      />
      <NumberField
        label="sweeper_interval_seconds"
        hint="how often the idle sweeper runs."
        initial={ingest.sweeper_interval_seconds}
        min={1}
        disabled={!editable}
        onSave={(n) => setConfigPath("server.memcore.ingest.sweeper_interval_seconds", n)}
      />
      <div className="row gap-2" style={{ alignItems: "center", marginTop: 8 }}>
        <input
          type="checkbox"
          checked={ingest.include_subagents === true}
          disabled={!editable}
          onChange={(e) =>
            void setConfigPath("server.memcore.ingest.include_subagents", e.target.checked)
          }
        />
        <span>include_subagents</span>
        <span className="hint" style={{ marginLeft: 8 }}>
          ingest subagent transcripts. off by default — the parent's reply usually summarises them.
        </span>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// raw config editor — universal backstop for any field a typed editor doesn't
// cover. Walks the live config tree and renders typed inputs per leaf. Each
// edit is one admin.config.set/unset call: the gateway re-validates against
// its schema atomically, so an invalid edit fails loud and the leaf shows the
// error inline.
// ─────────────────────────────────────────────────────────────────────────────

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

function joinPath(parent: string, segment: string | number): string {
  if (parent === "") return String(segment);
  return `${parent}.${segment}`;
}

function inferDefaultFor(template: JsonValue | undefined): JsonValue {
  if (template === undefined) return "";
  if (Array.isArray(template)) return [];
  if (template === null) return "";
  if (typeof template === "object") {
    // Use the first child's type as a hint for what siblings should look like;
    // empty otherwise.
    const sample = Object.values(template)[0];
    return sample === undefined ? {} : inferDefaultFor(sample as JsonValue);
  }
  if (typeof template === "string") return "";
  if (typeof template === "number") return 0;
  if (typeof template === "boolean") return false;
  return "";
}

function RawConfigViewer({
  fullConfig,
  refresh,
}: {
  fullConfig: FullConfigState | null;
  refresh: () => Promise<void>;
}): JSX.Element {
  const editable = !!fullConfig?.editable;
  const config = (fullConfig?.config ?? {}) as Record<string, JsonValue>;

  return (
    <Card
      title="raw config.json"
      actions={
        <button className="btn ghost sm" onClick={() => void refresh()}>
          reload
        </button>
      }
    >
      <div className="hint" style={{ marginBottom: 12 }}>
        every key in <span className="kbd">{fullConfig?.path ?? "(no file)"}</span>, rendered as a
        form. each leaf saves on blur and the gateway re-validates the whole tree against its
        schema — bad edits fail loud, valid ones are atomic.
      </div>
      <ObjectNode path="" value={config} editable={editable} />
    </Card>
  );
}

// ── recursive nodes ─────────────────────────────────────────────────────────

interface NodeProps {
  path: string;
  editable: boolean;
}

function ObjectNode({
  path,
  value,
  editable,
  removable,
  onRemove,
}: NodeProps & {
  value: Record<string, JsonValue>;
  removable?: boolean;
  onRemove?: () => Promise<void>;
}): JSX.Element {
  const { setConfigPath } = useGateway();
  const keys = Object.keys(value).sort();
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<"string" | "number" | "boolean" | "object" | "array">(
    "string",
  );
  const [error, setError] = useState<string | null>(null);

  const addKey = async (): Promise<void> => {
    const k = newKey.trim();
    if (!k) return;
    if (k in value) {
      setError(`"${k}" already exists`);
      return;
    }
    setError(null);
    let v: JsonValue;
    switch (newType) {
      case "number":
        v = 0;
        break;
      case "boolean":
        v = false;
        break;
      case "object":
        v = {};
        break;
      case "array":
        v = [];
        break;
      default:
        v = "";
    }
    try {
      await setConfigPath(joinPath(path, k), v);
      setNewKey("");
      setAdding(false);
    } catch (e) {
      setError((e as Error).message ?? "add failed");
    }
  };

  return (
    <div
      style={{
        marginLeft: path === "" ? 0 : 14,
        paddingLeft: path === "" ? 0 : 10,
        borderLeft: path === "" ? "none" : "1px solid var(--border-soft)",
      }}
    >
      {removable && (
        <div style={{ marginBottom: 6 }}>
          <button className="btn ghost sm" disabled={!editable} onClick={() => void onRemove?.()}>
            <Icon name="x" /> remove
          </button>
        </div>
      )}
      {keys.length === 0 && !adding && (
        <div className="hint" style={{ padding: "4px 0" }}>(empty object)</div>
      )}
      {keys.map((k) => (
        <KeyedNode key={k} parentPath={path} segment={k} value={value[k]!} editable={editable} />
      ))}
      <div style={{ marginTop: 6 }}>
        {adding ? (
          <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="input"
              autoFocus
              placeholder="key name"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addKey();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewKey("");
                  setError(null);
                }
              }}
              style={{ width: 160 }}
              disabled={!editable}
            />
            <select
              className="input"
              value={newType}
              onChange={(e) =>
                setNewType(e.target.value as "string" | "number" | "boolean" | "object" | "array")
              }
              disabled={!editable}
              style={{ width: 110 }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="object">object</option>
              <option value="array">array</option>
            </select>
            <button
              className="btn primary sm"
              onClick={() => void addKey()}
              disabled={!editable || !newKey.trim()}
            >
              add
            </button>
            <button
              className="btn ghost sm"
              onClick={() => {
                setAdding(false);
                setNewKey("");
                setError(null);
              }}
            >
              cancel
            </button>
            {error && (
              <span className="tag warn" title={error}>
                error
              </span>
            )}
          </div>
        ) : (
          <button className="btn ghost sm" disabled={!editable} onClick={() => setAdding(true)}>
            + add key
          </button>
        )}
      </div>
    </div>
  );
}

function ArrayNode({
  path,
  value,
  editable,
}: NodeProps & { value: JsonValue[] }): JSX.Element {
  const { setConfigPath, unsetConfigPath } = useGateway();
  const [error, setError] = useState<string | null>(null);

  const move = async (i: number, j: number): Promise<void> => {
    if (j < 0 || j >= value.length) return;
    setError(null);
    try {
      const next = value.slice();
      const tmp = next[i]!;
      next[i] = next[j]!;
      next[j] = tmp;
      await setConfigPath(path, next);
    } catch (e) {
      setError((e as Error).message ?? "move failed");
    }
  };

  const remove = async (i: number): Promise<void> => {
    setError(null);
    try {
      await unsetConfigPath(joinPath(path, i));
    } catch (e) {
      setError((e as Error).message ?? "remove failed");
    }
  };

  const append = async (): Promise<void> => {
    setError(null);
    try {
      const template = value.length > 0 ? value[value.length - 1] : undefined;
      const next = inferDefaultFor(template as JsonValue | undefined);
      await setConfigPath(joinPath(path, value.length), next);
    } catch (e) {
      setError((e as Error).message ?? "append failed");
    }
  };

  return (
    <div
      style={{
        marginLeft: 14,
        paddingLeft: 10,
        borderLeft: "1px solid var(--border-soft)",
      }}
    >
      {value.length === 0 && (
        <div className="hint" style={{ padding: "4px 0" }}>(empty array)</div>
      )}
      {value.map((v, i) => (
        <div
          key={i}
          style={{
            padding: "4px 0",
            borderBottom: i < value.length - 1 ? "1px dashed var(--border-soft)" : "none",
            marginBottom: 4,
          }}
        >
          <div className="row gap-2" style={{ alignItems: "center", marginBottom: 4 }}>
            <span className="faint mono" style={{ minWidth: 28 }}>
              [{i}]
            </span>
            <span className="spacer" />
            <button
              className="btn ghost sm"
              disabled={!editable || i === 0}
              onClick={() => void move(i, i - 1)}
              title="move up"
            >
              ↑
            </button>
            <button
              className="btn ghost sm"
              disabled={!editable || i === value.length - 1}
              onClick={() => void move(i, i + 1)}
              title="move down"
            >
              ↓
            </button>
            <button
              className="btn ghost sm"
              disabled={!editable}
              onClick={() => void remove(i)}
              title="remove"
            >
              <Icon name="x" />
            </button>
          </div>
          <ValueNode path={joinPath(path, i)} value={v} editable={editable} inline />
        </div>
      ))}
      <div style={{ marginTop: 6 }}>
        <button className="btn ghost sm" disabled={!editable} onClick={() => void append()}>
          + add item
        </button>
        {error && (
          <span className="tag warn" style={{ marginLeft: 8 }} title={error}>
            error
          </span>
        )}
      </div>
    </div>
  );
}

function KeyedNode({
  parentPath,
  segment,
  value,
  editable,
}: {
  parentPath: string;
  segment: string;
  value: JsonValue;
  editable: boolean;
}): JSX.Element {
  const { unsetConfigPath } = useGateway();
  const path = joinPath(parentPath, segment);
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const composite = isObject || isArray;

  const [open, setOpen] = useState(parentPath === ""); // default: expand top-level groups
  const [error, setError] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setError(null);
    try {
      await unsetConfigPath(path);
    } catch (e) {
      setError((e as Error).message ?? "remove failed");
    }
  };

  return (
    <div style={{ padding: "4px 0" }}>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        {composite && (
          <button
            className="btn ghost sm"
            onClick={() => setOpen((o) => !o)}
            style={{ padding: "0 4px", minWidth: 22 }}
            title={open ? "collapse" : "expand"}
          >
            {open ? "▾" : "▸"}
          </button>
        )}
        <span
          className="mono strong"
          style={{ minWidth: 200, color: "var(--fg-strong)" }}
          title={path}
        >
          {segment}
        </span>
        {!composite && (
          <ValueNode path={path} value={value} editable={editable} inline={false} />
        )}
        {composite && (
          <span className="faint" style={{ fontSize: "var(--t-sm)" }}>
            {isArray
              ? `array · ${(value as JsonValue[]).length} item${(value as JsonValue[]).length === 1 ? "" : "s"}`
              : `object · ${Object.keys(value as Record<string, JsonValue>).length} key${Object.keys(value as Record<string, JsonValue>).length === 1 ? "" : "s"}`}
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost sm" disabled={!editable} onClick={() => void remove()}>
          <Icon name="x" />
        </button>
      </div>
      {error && (
        <div className="hint" style={{ color: "var(--warn)", marginTop: 4 }}>
          {error}
        </div>
      )}
      {composite && open && isObject && (
        <ObjectNode
          path={path}
          value={value as Record<string, JsonValue>}
          editable={editable}
        />
      )}
      {composite && open && isArray && (
        <ArrayNode path={path} value={value as JsonValue[]} editable={editable} />
      )}
    </div>
  );
}

function ValueNode({
  path,
  value,
  editable,
  inline,
}: NodeProps & { value: JsonValue; inline: boolean }): JSX.Element {
  if (typeof value === "string") {
    return <ScalarString path={path} value={value} editable={editable} inline={inline} />;
  }
  if (typeof value === "number") {
    return <ScalarNumber path={path} value={value} editable={editable} />;
  }
  if (typeof value === "boolean") {
    return <ScalarBoolean path={path} value={value} editable={editable} />;
  }
  if (value === null) {
    return <ScalarNull path={path} editable={editable} />;
  }
  // Composite values shouldn't land here — KeyedNode renders them via their
  // own component. Defensive fallback: show as JSON.
  return (
    <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>
      {JSON.stringify(value)}
    </span>
  );
}

function ScalarString({
  path,
  value,
  editable,
  inline,
}: NodeProps & { value: string; inline: boolean }): JSX.Element {
  const { setConfigPath } = useGateway();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Heuristic: a path containing api_key / token / secret renders as a
  // password input. Same behaviour as the typed editors.
  const isSecret = /(?:^|\.)(?:api_key|key|token|secret|database_url)$/i.test(path) && !path.endsWith("api_key_env") && !path.endsWith(".path");
  const [reveal, setReveal] = useState(false);
  useEffect(() => setDraft(value), [value]);

  const dirty = draft !== value;
  const save = async (): Promise<void> => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      await setConfigPath(path, draft);
    } catch (e) {
      setError((e as Error).message ?? "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="row gap-2" style={{ flex: 1, alignItems: "center", flexWrap: "wrap" }}>
      <input
        className="input"
        type={isSecret && !reveal ? "password" : "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={!editable || saving}
        style={{ flex: inline ? 1 : "0 1 360px", minWidth: 180 }}
      />
      {isSecret && (
        <button
          className="btn ghost sm"
          onClick={() => setReveal((r) => !r)}
          disabled={!editable}
        >
          {reveal ? "hide" : "show"}
        </button>
      )}
      {dirty && (
        <button className="btn primary sm" onClick={() => void save()} disabled={!editable || saving}>
          save
        </button>
      )}
      {error && (
        <span className="tag warn" title={error}>
          error
        </span>
      )}
    </div>
  );
}

function ScalarNumber({
  path,
  value,
  editable,
}: NodeProps & { value: number }): JSX.Element {
  const { setConfigPath } = useGateway();
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(String(value)), [value]);

  const dirty = draft !== String(value);
  const save = async (): Promise<void> => {
    if (!dirty) return;
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setError("not a number");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setConfigPath(path, n);
    } catch (e) {
      setError((e as Error).message ?? "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="row gap-2" style={{ alignItems: "center" }}>
      <input
        className="input"
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(String(value));
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={!editable || saving}
        style={{ width: 160 }}
      />
      {dirty && (
        <button className="btn primary sm" onClick={() => void save()} disabled={!editable || saving}>
          save
        </button>
      )}
      {error && (
        <span className="tag warn" title={error}>
          error
        </span>
      )}
    </div>
  );
}

function ScalarBoolean({
  path,
  value,
  editable,
}: NodeProps & { value: boolean }): JSX.Element {
  const { setConfigPath } = useGateway();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row gap-2" style={{ alignItems: "center" }}>
      <input
        type="checkbox"
        checked={value}
        disabled={!editable}
        onChange={async (e) => {
          setError(null);
          try {
            await setConfigPath(path, e.target.checked);
          } catch (err) {
            setError((err as Error).message ?? "save failed");
          }
        }}
      />
      <span className="faint mono" style={{ fontSize: "var(--t-sm)" }}>
        {value ? "true" : "false"}
      </span>
      {error && (
        <span className="tag warn" title={error}>
          error
        </span>
      )}
    </div>
  );
}

function ScalarNull({
  path,
  editable,
}: NodeProps): JSX.Element {
  const { setConfigPath } = useGateway();
  return (
    <div className="row gap-2" style={{ alignItems: "center" }}>
      <span className="faint mono" style={{ fontSize: "var(--t-sm)" }}>
        null
      </span>
      <button
        className="btn ghost sm"
        disabled={!editable}
        onClick={() => void setConfigPath(path, "")}
        title="set to empty string"
      >
        set string
      </button>
    </div>
  );
}
