import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";

export interface AdminDeps {
  sessions: SessionStore;
  startedAt: number;
  version: string;
  defaultModel: string;
  providers: string[];
  subagents: { maxConcurrentGlobal: number; maxConcurrentPerParent: number; maxTreeDepth: number };
  approvals: { requireForTags: string[]; timeoutSeconds: number };
}

export function registerAdminMethods(dispatcher: Dispatcher, deps: AdminDeps): void {
  dispatcher.register("admin.health", async () => {
    const counts = deps.sessions.list({ limit: 1000 });
    return {
      ok: true,
      version: deps.version,
      uptimeSeconds: (Date.now() - deps.startedAt) / 1000,
      sessions: {
        active: counts.filter((s) => s.status === "running").length,
        total: counts.length,
      },
    };
  });

  dispatcher.register("admin.config", async () => ({
    defaultModel: deps.defaultModel,
    providers: deps.providers,
    subagents: deps.subagents,
    approvals: deps.approvals,
  }));

  // tokens.* writes are intentionally not in Phase 3. Added in Phase 10.
  dispatcher.register("admin.tokens.create", async () => {
    throw new Error("admin.tokens.create is not implemented in Phase 3");
  });
  dispatcher.register("admin.tokens.revoke", async () => {
    throw new Error("admin.tokens.revoke is not implemented in Phase 3");
  });
}
