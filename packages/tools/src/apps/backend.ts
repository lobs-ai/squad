/**
 * AppBackend — minimal interface the expose_app tools talk to. The gateway
 * implements this against its in-process AppRegistry. Tools never import the
 * gateway directly so this package stays free of gateway dependencies, and
 * the record shape is duplicated here (vs. imported from @squad/protocol)
 * for the same reason.
 */

export type AppScope = "persist" | "session";
export type AppHealth = "unknown" | "healthy" | "unhealthy" | "stopped";

export interface AppRecord {
  name: string;
  title: string;
  description?: string;
  host: string;
  port: number;
  scope: AppScope;
  sessionId?: string;
  registeredAt: number;
  health: AppHealth;
  lastProbeAt: number | null;
  info: Record<string, unknown> | null;
}

export interface RegisterAppRequest {
  name: string;
  title: string;
  description?: string;
  port: number;
  host?: string;
  scope?: AppScope;
  /** Stamped by the tool from ctx.meta.sessionId before calling the backend. */
  sessionId?: string;
}

export interface AppBackend {
  register(input: RegisterAppRequest): AppRecord;
  unregister(name: string): boolean;
  list(): AppRecord[];
  get(name: string): AppRecord | null;
}
