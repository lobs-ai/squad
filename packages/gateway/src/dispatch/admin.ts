import type { Dispatcher } from "./index.js";
import type { SessionStore } from "../db/sessions.js";
import { augmentWithExtras, listAvailableModels } from "@squad/llm";
import type { PeerSource } from "../peers/source.js";
import type { PairingStore } from "../auth/pairing.js";
import type { ConfigBackend, ToolRegistry } from "@squad/tools";
import { logger as rootLogger } from "../logger.js";

const log = rootLogger.child({ component: "dispatch.admin" });

export interface AdminDeps {
  sessions: SessionStore;
  startedAt: number;
  version: string;
  /** The configured primary model for new sessions. */
  primaryModel: string;
  /** The configured fallback chain, in order. */
  fallbackModels: string[];
  /** Provider names with credentials wired up. */
  providers: string[];
  subagents: { maxConcurrentGlobal: number; maxConcurrentPerParent: number; maxTreeDepth: number };
  approvals: {
    requireForTags: string[];
    requireForTools: string[];
    timeoutSeconds: number;
  };
  /**
   * Tool registry — used to surface `admin.tools.catalog` so the dashboard's
   * approvals editor can render meaningful pickers instead of asking the user
   * to type tool/tag names from memory.
   */
  toolRegistry?: ToolRegistry;
  /** Squad name as known to the manager (matches the docker compose service). */
  squadName: string;
  /** TCP port this gateway is listening on. */
  squadPort: number;
  /** Hostname this squad is bound to (default 127.0.0.1). */
  squadHost: string;
  /** Short build identifier — git sha or version. */
  build: string;
  /**
   * Display labels surfaced via `admin.identity.branding`. Sourced from the
   * gateway config; the dashboard and other clients read these to rebrand
   * the assistant and user speaker labels. Falls back to generic defaults
   * when empty.
   */
  branding: { agentName: string; userName: string };
  /** Source of peer info (reads ~/.squad/squads.json or env). */
  peers: PeerSource;
  /** Browser pairing store. Optional so older harnesses still wire admin.* */
  pairing?: PairingStore;
  /**
   * Read/write backend for the on-disk config.json. Present iff the gateway
   * was booted with a `configPath`. When absent, `admin.config.full` returns
   * the live in-memory config with `editable: false`, and `admin.config.set`
   * / `admin.config.unset` reject with a clear error.
   */
  configBackend?: ConfigBackend;
  /** Absolute path to config.json if `configBackend` is wired. */
  configPath?: string;
  /** A snapshot of the current live config — fallback when no backend exists. */
  liveConfigSnapshot?: () => Record<string, unknown>;
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
    primary: { model: deps.primaryModel },
    fallbacks: deps.fallbackModels.map((model) => ({ model })),
    providers: deps.providers,
    subagents: deps.subagents,
    approvals: deps.approvals,
  }));

  dispatcher.register("admin.config.full", async () => {
    if (deps.configBackend) {
      const config = await deps.configBackend.get();
      return {
        config,
        editable: true,
        path: deps.configPath ?? null,
      };
    }
    return {
      config: deps.liveConfigSnapshot ? deps.liveConfigSnapshot() : {},
      editable: false,
      path: null,
    };
  });

  dispatcher.register("admin.config.set", async (params) => {
    if (!deps.configBackend) {
      throw new Error(
        "config edits unavailable: gateway was started without SQUAD_CONFIG (no config.json to write to)",
      );
    }
    const config = await deps.configBackend.setValue(params.path, params.value);
    return { config };
  });

  dispatcher.register("admin.config.unset", async (params) => {
    if (!deps.configBackend) {
      throw new Error(
        "config edits unavailable: gateway was started without SQUAD_CONFIG (no config.json to write to)",
      );
    }
    const config = await deps.configBackend.unsetValue(params.path);
    return { config };
  });

  dispatcher.register("admin.models", async () => {
    // The catalog only knows the well-known providers (anthropic, openai,
    // google, …). Augment with the configured primary + fallback chain so
    // a user who set up a custom provider like `minimax/minimax-m2.7`
    // still sees their actual model in pickers.
    const catalog = listAvailableModels(deps.providers);
    const extras = [deps.primaryModel, ...deps.fallbackModels].filter(Boolean);
    const merged = augmentWithExtras(catalog, extras);
    return {
      models: merged.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        provider: m.provider,
        contextWindow: m.contextWindow,
        ...(m.notes !== undefined ? { notes: m.notes } : {}),
      })),
    };
  });

  dispatcher.register("admin.tools.catalog", async () => {
    const registry = deps.toolRegistry;
    if (!registry) return { tools: [] };
    const defs = registry.getDefinitions();
    const tools = defs
      .map((d) => ({
        name: d.name,
        description: d.description ?? "",
        tags: [...(d.tags ?? [])],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { tools };
  });

  dispatcher.register("admin.identity", async () => {
    // Read branding live from disk so an `admin.config.set` (or a hand-edit
    // of config.json) reflects on the next call instead of being frozen to
    // the values captured at boot. Falls back to the boot snapshot when no
    // backend is wired (e.g. test harnesses without a config file).
    let branding = deps.branding;
    if (deps.configBackend) {
      try {
        const live = (await deps.configBackend.get()) as {
          branding?: { agent_name?: string; user_name?: string };
        };
        branding = {
          agentName: live.branding?.agent_name || deps.branding.agentName,
          userName: live.branding?.user_name || deps.branding.userName,
        };
      } catch (err) {
        log.warn(
          { err },
          "admin.identity: live branding read failed — using boot snapshot",
        );
      }
    }
    return {
      name: deps.squadName,
      port: deps.squadPort,
      host: deps.squadHost,
      build: deps.build,
      version: deps.version,
      startedAt: new Date(deps.startedAt).toISOString(),
      branding,
    };
  });

  dispatcher.register("admin.peers", async () => ({ peers: deps.peers.list() }));

  // tokens.* writes are intentionally not in Phase 3. Added in Phase 10.
  dispatcher.register("admin.tokens.create", async () => {
    throw new Error("admin.tokens.create is not implemented in Phase 3");
  });
  dispatcher.register("admin.tokens.revoke", async () => {
    throw new Error("admin.tokens.revoke is not implemented in Phase 3");
  });

  if (deps.pairing) {
    const pairing = deps.pairing;
    dispatcher.register("admin.pair.list", async () => ({ pairings: pairing.list() }));
    dispatcher.register("admin.pair.approve", async (params, ctx) => {
      const view = pairing.approve({
        code: params.code,
        ...(ctx.grant.label !== undefined ? { approvedBy: ctx.grant.label } : {}),
      });
      return { pairing: view };
    });
    dispatcher.register("admin.pair.cancel", async (params) => {
      const view = pairing.cancel(params.code);
      if (!view) throw new Error(`unknown pairing code: ${params.code}`);
      return { pairing: view };
    });
  } else {
    const notWired = async (): Promise<never> => {
      throw new Error("browser pairing is not wired into this gateway");
    };
    dispatcher.register("admin.pair.list", notWired);
    dispatcher.register("admin.pair.approve", notWired);
    dispatcher.register("admin.pair.cancel", notWired);
  }
}
