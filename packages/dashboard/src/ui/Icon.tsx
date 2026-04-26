import type { CSSProperties } from "react";

export type IconName =
  | "chevron-down" | "chevron-right" | "search" | "play" | "stop" | "plus"
  | "check" | "x" | "lock" | "ask" | "spawn" | "tree" | "term" | "edit"
  | "read" | "tasks" | "session" | "plugin" | "settings" | "overview"
  | "chat" | "manager" | "kanban" | "command" | "circle" | "spark"
  | "sliders" | "bell" | "warn" | "filter" | "logs" | "external"
  | "branch" | "discord" | "cli" | "globe" | "moon" | "user" | "bot"
  | "diamond";

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 14, className = "", style }: IconProps): JSX.Element {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "icon " + className,
    style,
  };
  switch (name) {
    case "chevron-down":  return <svg {...p}><polyline points="6 9 12 15 18 9"/></svg>;
    case "chevron-right": return <svg {...p}><polyline points="9 6 15 12 9 18"/></svg>;
    case "search":        return <svg {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>;
    case "play":          return <svg {...p}><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>;
    case "stop":          return <svg {...p}><rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="none"/></svg>;
    case "plus":          return <svg {...p}><path d="M12 5v14M5 12h14"/></svg>;
    case "check":         return <svg {...p}><polyline points="20 6 9 17 4 12"/></svg>;
    case "x":             return <svg {...p}><path d="M18 6 6 18M6 6l12 12"/></svg>;
    case "lock":          return <svg {...p}><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>;
    case "ask":           return <svg {...p}><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><circle cx="12" cy="18" r=".6" fill="currentColor"/></svg>;
    case "spawn":         return <svg {...p}><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v3M7 17l4-5M17 17l-4-5"/></svg>;
    case "tree":          return <svg {...p}><circle cx="6" cy="6" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h2a4 4 0 0 1 4 4v2M14 16v0a4 4 0 0 1 0-4"/></svg>;
    case "term":          return <svg {...p}><polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="19" y2="16"/></svg>;
    case "edit":          return <svg {...p}><path d="M14 4l6 6-10 10H4v-6z"/></svg>;
    case "read":          return <svg {...p}><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h6"/></svg>;
    case "tasks":         return <svg {...p}><rect x="3" y="4" width="6" height="6" rx="1"/><rect x="3" y="14" width="6" height="6" rx="1"/><path d="M13 7h8M13 17h8"/></svg>;
    case "session":       return <svg {...p}><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>;
    case "plugin":        return <svg {...p}><path d="M9 3v4M15 3v4M5 7h14v6a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z"/></svg>;
    case "settings":      return <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.5a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2L10 21h4l.6-2.5c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/></svg>;
    case "overview":      return <svg {...p}><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="5"/><rect x="13" y="10" width="8" height="11"/><rect x="3" y="13" width="8" height="8"/></svg>;
    case "chat":          return <svg {...p}><path d="M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z"/></svg>;
    case "manager":       return <svg {...p}><rect x="3" y="4" width="7" height="7"/><rect x="14" y="4" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>;
    case "kanban":        return <svg {...p}><rect x="3" y="4" width="5" height="16"/><rect x="10" y="4" width="5" height="10"/><rect x="17" y="4" width="4" height="13"/></svg>;
    case "command":       return <svg {...p}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></svg>;
    case "circle":        return <svg {...p}><circle cx="12" cy="12" r="9"/></svg>;
    case "spark":         return <svg {...p}><path d="M5 18l4-8 3 5 3-3 4 6"/></svg>;
    case "sliders":       return <svg {...p}><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>;
    case "bell":          return <svg {...p}><path d="M6 17h12l-1.5-2V11a4.5 4.5 0 1 0-9 0v4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>;
    case "warn":          return <svg {...p}><path d="M12 4 2 20h20z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>;
    case "filter":        return <svg {...p}><path d="M3 5h18l-7 9v6l-4-2v-4z"/></svg>;
    case "logs":          return <svg {...p}><path d="M4 5h16M4 9h16M4 13h10M4 17h12"/></svg>;
    case "external":      return <svg {...p}><path d="M14 5h5v5M19 5l-9 9M11 5H5v14h14v-6"/></svg>;
    case "branch":        return <svg {...p}><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M6 9c0 4 4 4 8 0"/></svg>;
    case "discord":       return <svg {...p}><path d="M7 8c2-1 8-1 10 0M7 16c2 1 8 1 10 0M5 7l-1 9c0 1 2 3 5 3l1-2M19 7l1 9c0 1-2 3-5 3l-1-2"/><circle cx="9" cy="12" r=".8" fill="currentColor"/><circle cx="15" cy="12" r=".8" fill="currentColor"/></svg>;
    case "cli":           return <svg {...p}><path d="M3 5h18v14H3z"/><polyline points="6 10 9 13 6 16"/><line x1="11" y1="16" x2="16" y2="16"/></svg>;
    case "globe":         return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>;
    case "moon":          return <svg {...p}><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/></svg>;
    case "user":          return <svg {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>;
    case "bot":           return <svg {...p}><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 3v4"/><circle cx="9" cy="13" r=".8" fill="currentColor"/><circle cx="15" cy="13" r=".8" fill="currentColor"/></svg>;
    case "diamond":       return <svg {...p}><path d="M12 3 21 12 12 21 3 12z"/></svg>;
    default:              return <svg {...p}><circle cx="12" cy="12" r="3"/></svg>;
  }
}
