export type ViewId =
  | "overview"
  | "chat"
  | "tasks"
  | "sessions"
  | "plugins"
  | "settings"
  | "manager"
  | "routines"
  | `plugin:${string}`;
