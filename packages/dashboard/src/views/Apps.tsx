import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, PageHead } from "../ui/primitives.js";
import { useGateway } from "../state/GatewayContext.js";
import type { AppRecord, AppHealth } from "@squad/protocol";
import type { ViewId } from "./views.js";

interface Props {
  view: ViewId;
  setView: (v: ViewId) => void;
}

const HEALTH_TONE: Record<AppHealth, { color: string; label: string }> = {
  unknown: { color: "var(--fg-faint)", label: "probing" },
  healthy: { color: "var(--ok)", label: "healthy" },
  unhealthy: { color: "var(--err)", label: "unhealthy" },
  stopped: { color: "var(--fg-faint)", label: "stopped" },
};

/**
 * Apps view — lists every registered agent-spawned web app and lets the user
 * open one in an in-page iframe. Subscribes to apps.* broadcast events so a
 * fresh `expose_app` shows up without polling.
 *
 * URL convention: when a specific app is selected the view writes the active
 * tab as `apps:<name>` so the App-level persisted view selector recovers it
 * across reloads. The Apps overview is just `apps`.
 */
export function Apps({ view, setView }: Props): JSX.Element {
  const { client } = useGateway();
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const subscribedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const { apps: list } = await client.request("apps.list", {});
      setApps(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (subscribedRef.current) return;
    subscribedRef.current = true;
    void client.subscribe(["apps.registered", "apps.unregistered", "apps.health_changed"]);
    const unsubscribe = client.onEvent((topic, data) => {
      if (topic === "apps.registered") {
        const next = (data as { app: AppRecord }).app;
        setApps((prev) => {
          const without = prev.filter((a) => a.name !== next.name);
          return [...without, next].sort((a, b) => a.name.localeCompare(b.name));
        });
      } else if (topic === "apps.unregistered") {
        const name = (data as { name: string }).name;
        setApps((prev) => prev.filter((a) => a.name !== name));
      } else if (topic === "apps.health_changed") {
        const { name, health, lastProbeAt } = data as {
          name: string;
          health: AppHealth;
          lastProbeAt: number;
        };
        setApps((prev) =>
          prev.map((a) => (a.name === name ? { ...a, health, lastProbeAt } : a)),
        );
      }
    });
    return () => unsubscribe();
  }, [client]);

  const selectedName = view.startsWith("apps:") ? view.slice("apps:".length) : null;
  const selected = useMemo(
    () => (selectedName ? apps.find((a) => a.name === selectedName) ?? null : null),
    [apps, selectedName],
  );

  if (selected) {
    return <AppFrame app={selected} onBack={() => setView("apps")} />;
  }

  return (
    <div className="page">
      <PageHead title="apps" crumbs="agent-exposed web apps" />
      {error && (
        <div className="card" style={{ borderColor: "var(--err)", padding: 12, marginBottom: 12 }}>
          <span style={{ color: "var(--err)" }}>{error}</span>
        </div>
      )}
      {apps.length === 0 ? (
        <Card title="no apps registered">
          <div style={{ padding: 12 }}>
            <p>
              Agents register web apps by spawning a server (with <code>exec</code>) and calling{" "}
              <code>expose_app({"{ name, title, port }"})</code>. The dashboard mounts each app at{" "}
              <code>/apps/&lt;name&gt;/</code>.
            </p>
            <p className="hint">
              Apps built with <code>@squad/app-sdk</code> auto-mount{" "}
              <code>/squad/info</code> and <code>/squad/health</code> for the prober.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {apps.map((app) => (
            <AppCard key={app.name} app={app} onOpen={() => setView(`apps:${app.name}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AppCard({ app, onOpen }: { app: AppRecord; onOpen: () => void }): JSX.Element {
  const tone = HEALTH_TONE[app.health];
  return (
    <Card
      title={app.title}
      badge={
        <span
          className="dot"
          style={{ background: tone.color, marginLeft: 6 }}
          title={tone.label}
        />
      }
      actions={
        <button className="btn" onClick={onOpen}>
          open
        </button>
      }
    >
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="mono hint">/apps/{app.name}/</span>
        {app.description && <span style={{ fontSize: "var(--t-sm)" }}>{app.description}</span>}
        <div className="row gap-2 hint" style={{ fontSize: "var(--t-xs)" }}>
          <span>port {app.port}</span>
          <span>•</span>
          <span>{app.scope === "session" ? "session-scoped" : "persisted"}</span>
          <span>•</span>
          <span style={{ color: tone.color }}>{tone.label}</span>
        </div>
      </div>
    </Card>
  );
}

function AppFrame({ app, onBack }: { app: AppRecord; onBack: () => void }): JSX.Element {
  const tone = HEALTH_TONE[app.health];
  // The cookie set on connect (path=/apps/) carries auth into the iframe.
  // Append a cache-buster on health flips so a previously-failing iframe
  // reloads when the upstream comes back.
  const src = `/apps/${app.name}/${app.health === "healthy" ? `?_=${app.lastProbeAt ?? ""}` : ""}`;
  return (
    <div className="page" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PageHead
        title={app.title}
        crumbs={
          <span>
            <a className="link" onClick={onBack}>apps</a> / <span className="mono">{app.name}</span>
          </span>
        }
        actions={
          <span className="row gap-2">
            <span style={{ color: tone.color }}>{tone.label}</span>
            <a className="btn" href={`/apps/${app.name}/`} target="_blank" rel="noreferrer">
              open in new tab
            </a>
          </span>
        }
      />
      <div style={{ flex: 1, minHeight: 0, border: "1px solid var(--line)" }}>
        <iframe
          key={src}
          src={src}
          title={app.title}
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      </div>
    </div>
  );
}
