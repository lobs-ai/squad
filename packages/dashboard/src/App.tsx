import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProtocolClient } from "./protocol-client.js";
import { GatewayProvider, useGateway } from "./state/GatewayContext.js";
import { usePersistedState } from "./state/usePersistedState.js";
import { TopNav } from "./chrome/TopNav.js";
import { Sidebar } from "./chrome/Sidebar.js";
import { StatusBar } from "./chrome/StatusBar.js";
import { Overview } from "./views/Overview.js";
import { Chat } from "./views/Chat.js";
import { Tasks } from "./views/Tasks.js";
import { Sessions } from "./views/Sessions.js";
import { Manager } from "./views/Manager.js";
import { Plugins } from "./views/Plugins.js";
import { Settings } from "./views/Settings.js";
import { CommandPalette } from "./views/CommandPalette.js";
import { Gate } from "./views/Gate.js";
import { Routines } from "./views/Routines.js";
import { SearchView } from "./views/Search.js";
import { Logs } from "./views/Logs.js";
import { Apps } from "./views/Apps.js";
import type { ViewId } from "./views/views.js";
import "./styles/tokens.css";
import "./styles/styles.css";

export function App(): JSX.Element {
  const [client, setClient] = useState<BrowserProtocolClient | null>(null);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "127.0.0.1:8080";
    return `${proto}//${host}/ws`;
  }, []);

  const connect = useCallback(
    async (token: string, opts: { remember?: boolean } = {}) => {
      const c = new BrowserProtocolClient(wsUrl, token);
      await c.connect();
      // Only persist after a successful connect — a bogus token shouldn't
      // pollute localStorage and force the user into a logout dance.
      if (opts.remember !== false) {
        try {
          localStorage.setItem("squad-token", token);
        } catch {
          // Safari private mode etc. — fine to skip persistence.
        }
      }
      // Drop a cookie scoped to /apps/ so iframed agent apps authenticate
      // automatically. The path scope keeps the token from leaking into
      // dashboard statics or the API. Lifetime: session cookie (no Expires).
      try {
        document.cookie = `squad_token=${encodeURIComponent(token)}; path=/apps/; SameSite=Strict`;
      } catch {
        // ignore — cookies disabled means /apps/* iframes will get 401, which is fair.
      }
      setClient(c);
    },
    [wsUrl],
  );

  // Auto-reconnect with a saved token. Failures fall through silently to
  // the gate — we don't want a stale token to block the pair flow.
  useEffect(() => {
    if (client) return;
    const saved = (() => {
      try {
        return localStorage.getItem("squad-token");
      } catch {
        return null;
      }
    })();
    if (!saved) return;
    void (async () => {
      try {
        await connect(saved, { remember: false });
      } catch {
        try {
          localStorage.removeItem("squad-token");
        } catch {
          // ignore
        }
      }
    })();
  }, [client, connect]);

  useEffect(() => {
    return () => {
      client?.close();
    };
  }, [client]);

  if (!client) {
    return <Gate onConnect={(t, opts) => connect(t, opts)} />;
  }

  return (
    <GatewayProvider client={client}>
      <Shell />
    </GatewayProvider>
  );
}

function Shell(): JSX.Element {
  const [theme, setTheme] = usePersistedState("squad-theme", "dark");
  const [density, setDensity] = usePersistedState("squad-density", "comfortable");
  const [accent, setAccent] = usePersistedState("squad-accent", "#5b8def");
  const [viewRaw, setViewRaw] = usePersistedState("squad-view", "overview");
  const view = viewRaw as ViewId;
  const setView = setViewRaw as (v: ViewId) => void;
  const [cmdOpen, setCmdOpen] = useState(false);
  const goSequenceRef = useRef<number>(0);
  const { setActiveSessionId, startSession, squad } = useGateway();

  // ChatGPT-style: clicking "new chat" creates a session with the gateway's
  // configured primary model + fallbacks and drops the user straight into
  // the chat view. No model picker, no title prompt — the AI titles the
  // session itself once content shows up.
  const newChat = useCallback(async (): Promise<void> => {
    await startSession({});
    setView("chat");
  }, [startSession]);

  // Switching to a sibling squad means a different gateway URL. The simplest
  // safe behavior is to navigate the browser tab to the peer's host:port —
  // that swaps the entire SPA into a new connection without dragging stale
  // state along. For the active squad it's a no-op.
  const onPickPeer = useCallback(
    (peer: { name: string; port: number; url: string }) => {
      if (squad && peer.name === squad.name) return;
      const proto = window.location.protocol === "https:" ? "https:" : "http:";
      // Host can be 0.0.0.0 in some configs — fall back to the current host.
      const host = window.location.hostname;
      window.location.href = `${proto}//${host}:${peer.port}/`;
    },
    [squad],
  );

  // Apply theme + density + accent to the document so tokens.css reacts.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-soft", accent + "22");
    document.documentElement.style.setProperty("--accent-line", accent + "55");
  }, [theme, density, accent]);

  // Global hotkeys: ⌘K, esc, and `g <key>` go-to combinations.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        // ⌘N — instantly create a chat with the gateway defaults.
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        void newChat();
        return;
      }
      if (e.key === "Escape") {
        setCmdOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const now = Date.now();
      if (e.key === "g") {
        goSequenceRef.current = now;
        return;
      }
      if (now - goSequenceRef.current < 1200) {
        const map: Record<string, ViewId> = {
          o: "overview",
          c: "chat",
          t: "tasks",
          s: "sessions",
          p: "plugins",
          m: "manager",
          l: "logs",
        };
        const target = map[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          setView(target);
          goSequenceRef.current = 0;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  const onOpenSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      setView("chat");
    },
    [setActiveSessionId],
  );

  return (
    <div className="app">
      <TopNav
        view={view}
        setView={setView}
        onCmdK={() => setCmdOpen(true)}
        onNewChat={() => void newChat()}
        onOpenManager={() => setView("manager")}
        onPickPeer={onPickPeer}
      />
      <div className="main">
        <Sidebar view={view} setView={setView} onNewChat={() => void newChat()} />
        <div className="workspace" data-screen-label={view}>
          {view === "overview" && (
            <Overview
              setView={setView}
              onOpenSession={onOpenSession}
              onNewChat={() => void newChat()}
            />
          )}
          {view === "chat" && <Chat />}
          {view === "tasks" && <Tasks onOpenSession={onOpenSession} />}
          {view === "sessions" && <Sessions onOpenSession={onOpenSession} />}
          {view === "plugins" && <Plugins onOpenSession={onOpenSession} />}
          {view === "routines" && <Routines />}
          {view === "search" && <SearchView onOpenSession={onOpenSession} />}
          {view === "logs" && <Logs />}
          {(view === "apps" || view.startsWith("apps:")) && (
            <Apps view={view} setView={setView} />
          )}
          {view === "manager" && (
            <Manager
              onPickPeer={(peer) => {
                if (squad && peer.name === squad.name) {
                  setView("overview");
                  return;
                }
                onPickPeer(peer);
              }}
            />
          )}
          {view === "settings" && (
            <Settings
              theme={theme}
              setTheme={setTheme}
              density={density}
              setDensity={setDensity}
              accent={accent}
              setAccent={setAccent}
            />
          )}
        </div>
      </div>
      <StatusBar setView={setView} />
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        setView={setView}
        onPickSession={onOpenSession}
        onNewChat={() => void newChat()}
      />
    </div>
  );
}
