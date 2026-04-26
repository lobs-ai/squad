import { Card, PageHead } from "../ui/primitives.js";
import { Icon } from "../ui/Icon.js";
import { useGateway } from "../state/GatewayContext.js";
import type { PluginRecord } from "@squad/protocol";

const KIND_COLOR: Record<string, string> = {
  tool: "",
  provider: "",
  channel: "info",
  skill: "accent",
  routine: "",
  subagent: "info",
};

export function Plugins(): JSX.Element {
  const { plugins, squad, client, reloadPlugin } = useGateway();
  const reloadAll = async (): Promise<void> => {
    await Promise.all(
      plugins.map((p) => reloadPlugin(p.id).catch(() => {})),
    );
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

  const toggle = (p: PluginRecord): void => {
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
            <span className="hint" title="install via the CLI: `squad plugins add <path|spec>`">
              install via <span className="kbd">squad plugins add</span>
            </span>
          </div>
        }
      />
      <div style={{ padding: 16 }}>
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
              no plugins installed. add one with <span className="kbd">squad plugins add &lt;src&gt;</span>.
            </div>
          )}
          {plugins.map((p) => (
            <div
              key={p.id}
              className="row gap-2"
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: "var(--t-sm)",
              }}
            >
              <span
                style={{ width: 12 }}
                className={"dot " + (p.enabled ? "ok" : "off")}
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
                {p.enabled ? <span className="tag ok">enabled</span> : <span className="tag">disabled</span>}
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
