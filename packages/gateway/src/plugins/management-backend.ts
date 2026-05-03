import type {
  PluginManagementBackend,
  PluginCatalogEntrySummary,
  PluginConfigFieldSummary,
  PluginDescribeResult,
  PluginInstallResult,
  PluginUninstallResult,
  PluginSetupChatResult,
} from "@squad/tools";
import { ProtocolError } from "@squad/protocol";
import type { Dispatcher, DispatchContext } from "../dispatch/index.js";

/**
 * In-process backend the plugin-management agent tools call into. Routes
 * each tool through the dispatcher with a synthetic admin grant — that
 * way validation, rollback, secret-store wiring, and auth.tokens mutation
 * all live in `dispatch/plugins.ts` and never get duplicated.
 *
 * The synthetic grant is wide-open because the plugin tools are
 * registered into the gateway's process and only callable by an in-process
 * agent run; the wire-side dispatcher still enforces real grants for
 * external callers.
 */
export function buildPluginManagementBackend(args: {
  dispatcher: Dispatcher;
  /** Used to satisfy the dispatcher's authentication shim. */
  systemContext: DispatchContext;
}): PluginManagementBackend {
  const { dispatcher, systemContext } = args;

  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    return dispatcher.dispatch(method, params, systemContext) as Promise<T>;
  };

  return {
    async list(): Promise<PluginCatalogEntrySummary[]> {
      // We need both catalog + list to produce the merged summary the
      // agent-friendly tool format expects (catalog gives "available",
      // list gives "loaded" + error details for failed entries).
      const [{ entries }, { plugins }] = await Promise.all([
        call<{ entries: Array<{ id: string; name: string; description: string; kinds: string[]; installed: boolean; loaded: boolean }> }>(
          "plugins.catalog",
          {},
        ),
        call<{ plugins: Array<{ id: string; status: string; source: string; error?: { code: string; message: string; field?: string; envVar?: string; hint?: string } }> }>(
          "plugins.list",
          {},
        ),
      ]);
      // Index installed records by source path so we can attach error
      // info even when the catalog id doesn't match the descriptor id.
      const recordsBySource = new Map(
        plugins.map((p) => [p.source, p] as const),
      );
      const out: PluginCatalogEntrySummary[] = [];
      for (const e of entries) {
        const record = recordsBySource.get(
          (entries.find((c) => c.id === e.id) as { source?: string } | undefined)
            ?.source ?? "",
        );
        const summary: PluginCatalogEntrySummary = {
          id: e.id,
          name: e.name,
          description: e.description,
          kinds: e.kinds,
          installed: e.installed,
          loaded: e.loaded,
        };
        if (record?.status === "failed" && record.error) {
          summary.error = {
            code: record.error.code,
            message: record.error.message,
            ...(record.error.field !== undefined ? { field: record.error.field } : {}),
            ...(record.error.envVar !== undefined ? { envVar: record.error.envVar } : {}),
            ...(record.error.hint !== undefined ? { hint: record.error.hint } : {}),
          };
        }
        out.push(summary);
      }
      return out;
    },

    async describe(id: string): Promise<PluginDescribeResult | null> {
      try {
        const r = await call<{
          id: string;
          name: string;
          description: string;
          fields: PluginConfigFieldSummary[];
          defaultConfig: Record<string, unknown>;
          currentConfig?: Record<string, unknown>;
          needsAuthToken: boolean;
          secrets: Array<{ envVar: string; label?: string; required?: boolean; hint?: string; set: boolean }>;
          setupPlaybook?: string;
        }>("plugins.describe", { id });
        // Project the dispatcher's secrets onto the form-field shape used
        // by the agent. Each becomes a string field with `secret: true` so
        // the existing PluginConfigFieldSummary covers it without an
        // additional schema.
        const secretFields: PluginConfigFieldSummary[] = r.secrets.map((s) => ({
          name: s.envVar,
          kind: "string",
          required: Boolean(s.required) && !s.set,
          ...(s.label ? { description: s.label + (s.set ? " (already set)" : "") } : {}),
          ...(s.hint ? { description: (s.hint ?? "") + (s.set ? " (already set)" : "") } : {}),
          secret: true,
        }));
        const result: PluginDescribeResult = {
          id: r.id,
          name: r.name,
          description: r.description,
          fields: [...r.fields, ...secretFields],
          defaultConfig: r.defaultConfig,
          needsAuthToken: r.needsAuthToken,
        };
        if (r.currentConfig !== undefined) result.currentConfig = r.currentConfig;
        if (r.setupPlaybook !== undefined) result.setupPlaybook = r.setupPlaybook;
        return result;
      } catch (err) {
        // Unknown id should return null so the tool produces a clean
        // "unknown plugin" instead of an internal error.
        if (err instanceof Error && err.message.includes("unknown preinstalled plugin")) {
          return null;
        }
        throw err;
      }
    },

    async install(
      id: string,
      config: Record<string, unknown>,
      secrets: Record<string, string>,
    ): Promise<PluginInstallResult> {
      // Be forgiving if the agent put a secret into `config` instead of
      // `secrets` (matches the older tool schema's behaviour). We can ask
      // describe what the catalog declares as secrets and re-route silently
      // — better than rejecting a call that's structurally fine.
      let routedConfig = config;
      let routedSecrets = secrets;
      try {
        const desc = await call<{ secrets: Array<{ envVar: string }> }>(
          "plugins.describe",
          { id },
        );
        const secretEnvVars = new Set(desc.secrets.map((s) => s.envVar));
        const movedSecrets: Record<string, string> = { ...secrets };
        const cleanConfig: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(config)) {
          if (secretEnvVars.has(k) && typeof v === "string" && v.length > 0) {
            // Don't clobber an explicit secrets-map entry with a config one.
            if (movedSecrets[k] === undefined) movedSecrets[k] = v;
          } else {
            cleanConfig[k] = v;
          }
        }
        routedConfig = cleanConfig;
        routedSecrets = movedSecrets;
      } catch {
        // describe failed → fall through with the raw inputs and let the
        // dispatcher's own validation produce the error.
      }
      try {
        const r = await call<{ plugin: { id: string; name: string; version: string } }>(
          "plugins.install",
          {
            id,
            config: routedConfig,
            ...(Object.keys(routedSecrets).length > 0 ? { secrets: routedSecrets } : {}),
          },
        );
        return {
          ok: true,
          pluginId: r.plugin.id,
          name: r.plugin.name,
          version: r.plugin.version,
        };
      } catch (err) {
        if (err instanceof ProtocolError) {
          const data = (err.data ?? {}) as Record<string, unknown>;
          const failure: PluginInstallResult = {
            ok: false,
            code: typeof data["code"] === "string" ? (data["code"] as string) : err.code,
            message: err.message,
          };
          if (typeof data["field"] === "string")
            (failure as { field?: string }).field = data["field"] as string;
          if (typeof data["envVar"] === "string")
            (failure as { envVar?: string }).envVar = data["envVar"] as string;
          if (typeof data["hint"] === "string")
            (failure as { hint?: string }).hint = data["hint"] as string;
          return failure;
        }
        return {
          ok: false,
          code: "unknown",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async uninstall(id: string): Promise<PluginUninstallResult> {
      try {
        await call("plugins.uninstall", { id });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async startSetupChat(id: string): Promise<PluginSetupChatResult | null> {
      try {
        const r = await call<{ sessionId: string }>("plugins.start_setup_chat", { id });
        return { sessionId: r.sessionId };
      } catch (err) {
        if (err instanceof Error && err.message.includes("unknown preinstalled plugin")) {
          return null;
        }
        throw err;
      }
    },
  };
}
