export type ViewId =
  | "overview"
  | "chat"
  | "tasks"
  | "sessions"
  | "plugins"
  | "settings"
  | "manager"
  | "routines"
  | "search"
  | "logs"
  | `plugin:${string}`;
