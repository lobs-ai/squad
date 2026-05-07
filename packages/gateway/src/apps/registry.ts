import type { AppHealth, AppRecord, AppScope } from "@squad/protocol";
import type { Logger } from "../logger.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AppRegistryCallbacks {
  onRegistered?: (app: AppRecord) => void;
  onUnregistered?: (name: string) => void;
  onHealthChanged?: (
    name: string,
    health: AppHealth,
    lastProbeAt: number,
  ) => void;
}

export interface RegisterAppInput {
  name: string;
  title: string;
  description?: string;
  port: number;
  host?: string;
  scope?: AppScope;
  /** Bound to the app when scope === "session". */
  sessionId?: string;
}

interface AppEntry extends AppRecord {}

/**
 * In-memory map of registered apps. The gateway's HTTP dispatcher consults
 * this to proxy `/apps/<name>/*` requests, the prober updates `health` from
 * `GET /squad/health` results, and the dashboard renders entries via
 * `apps.list`.
 *
 * Apps live in process memory only — registrations don't survive a gateway
 * restart, since the spawned child processes don't either.
 */
export class AppRegistry {
  private readonly entries: Map<string, AppEntry> = new Map();

  constructor(
    private readonly logger: Logger,
    private readonly cb: AppRegistryCallbacks = {},
  ) {}

  register(input: RegisterAppInput): AppRecord {
    if (!NAME_RE.test(input.name)) {
      throw new Error(
        `app name must match ${NAME_RE} (lowercase, digits, hyphens), got: ${input.name}`,
      );
    }
    if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
      throw new Error(`app port must be an integer in [1, 65535], got: ${input.port}`);
    }
    if (this.entries.has(input.name)) {
      throw new Error(`app already registered: ${input.name}`);
    }
    const scope = input.scope ?? "persist";
    const record: AppEntry = {
      name: input.name,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      host: input.host ?? "127.0.0.1",
      port: input.port,
      scope,
      ...(scope === "session" && input.sessionId !== undefined
        ? { sessionId: input.sessionId }
        : {}),
      registeredAt: Date.now(),
      health: "unknown",
      lastProbeAt: null,
      info: null,
    };
    this.entries.set(input.name, record);
    this.logger.info(
      { name: input.name, port: input.port, scope, sessionId: input.sessionId },
      "app registered",
    );
    this.cb.onRegistered?.(record);
    return record;
  }

  unregister(name: string): boolean {
    if (!this.entries.delete(name)) return false;
    this.logger.info({ name }, "app unregistered");
    this.cb.onUnregistered?.(name);
    return true;
  }

  /**
   * Drop every app whose `scope === "session"` and `sessionId` matches.
   * Called from `session.end` so session-scoped apps clean up automatically.
   */
  dropForSession(sessionId: string): string[] {
    const dropped: string[] = [];
    for (const [name, entry] of this.entries) {
      if (entry.scope === "session" && entry.sessionId === sessionId) {
        this.entries.delete(name);
        dropped.push(name);
        this.cb.onUnregistered?.(name);
      }
    }
    if (dropped.length > 0) {
      this.logger.info({ sessionId, dropped }, "session-scoped apps dropped");
    }
    return dropped;
  }

  get(name: string): AppRecord | null {
    return this.entries.get(name) ?? null;
  }

  list(): AppRecord[] {
    return Array.from(this.entries.values());
  }

  /** Update the cached health/info for an app — called by the prober. */
  setHealth(
    name: string,
    health: AppHealth,
    info: Record<string, unknown> | null,
  ): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    const now = Date.now();
    const changed = entry.health !== health;
    entry.health = health;
    entry.lastProbeAt = now;
    if (info !== null) entry.info = info;
    if (changed) this.cb.onHealthChanged?.(name, health, now);
  }
}
