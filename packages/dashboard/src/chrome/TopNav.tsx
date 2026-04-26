import type { PeerRecord } from "@squad/protocol";
import { Icon, type IconName } from "../ui/Icon.js";
import type { ViewId } from "../views/views.js";
import { useGateway } from "../state/GatewayContext.js";
import { SquadPicker } from "./SquadPicker.js";

interface Props {
  view: ViewId;
  setView: (v: ViewId) => void;
  onCmdK: () => void;
  onNewChat: () => void;
  onOpenManager: () => void;
  onPickPeer: (peer: PeerRecord) => void;
}

const TABS: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "tasks", label: "Tasks", icon: "kanban" },
  { id: "sessions", label: "Sessions", icon: "session" },
  { id: "routines", label: "Routines", icon: "spark" },
  { id: "plugins", label: "Plugins", icon: "plugin" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function TopNav({ view, setView, onCmdK, onNewChat, onOpenManager, onPickPeer }: Props): JSX.Element {
  const { squad, peers, pendingQuestions, pendingApprovals, plugins } = useGateway();
  const pending = pendingQuestions.length + pendingApprovals.length;

  // Plugin-contributed nav tabs come from `uiContributions` of slot
  // "navTab". Older gateways without UI contributions just produce no
  // extra tabs, which is fine.
  const pluginTabs = plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.uiContributions
        .filter((c) => c.slot === "navTab")
        .map((c) => ({
          id: ("plugin:" + p.id + ":" + c.id) as ViewId,
          label: c.label,
          icon: (c.icon ?? "spark") as IconName,
          from: p.id,
        })),
    );

  return (
    <div className="topnav">
      <SquadPicker squad={squad} peers={peers} onPickPeer={onPickPeer} onOpenManager={onOpenManager} />
      <div className="nav-tabs">
        {TABS.map((t) => (
          <div
            key={t.id}
            className={"tab " + (view === t.id ? "active" : "")}
            onClick={() => setView(t.id)}
          >
            <Icon name={t.icon} size={13} />
            <span>{t.label}</span>
            {t.id === "overview" && pending > 0 && (
              <span className="tag accent" style={{ marginLeft: 4 }}>
                {pending}
              </span>
            )}
          </div>
        ))}
        {pluginTabs.map((t) => (
          <div
            key={t.id}
            className={"tab " + (view === t.id ? "active" : "")}
            onClick={() => setView(t.id)}
            title={"contributed by plugin: " + t.from}
          >
            <Icon name={t.icon} size={13} className="faint" />
            <span>{t.label}</span>
            <span className="tag" style={{ marginLeft: 4, fontSize: 9 }}>
              plugin
            </span>
          </div>
        ))}
      </div>
      <div className="nav-right">
        <div className="btn ghost" onClick={onNewChat} style={{ gap: 6 }} title="New chat (⌘N)">
          <Icon name="plus" size={12} />
          <span className="muted">new</span>
          <span className="kbd">⌘N</span>
        </div>
        <div className="btn ghost" onClick={onCmdK} style={{ gap: 8 }} title="Command palette (⌘K)">
          <Icon name="search" size={12} />
          <span className="muted">jump…</span>
          <span className="kbd">⌘K</span>
        </div>
      </div>
    </div>
  );
}
