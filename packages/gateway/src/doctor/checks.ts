/**
 * Built-in checks for the Squad Doctor.
 *
 * Each factory returns a `Check` bound to the gateway subsystems it inspects.
 * Checks are intentionally small, self-contained, and side-effect-free at
 * `run()` time — fixes do the work. The engine handles error trapping, so
 * checks can be straight-line code that focuses on the diagnosis logic.
 */

import { accessSync, constants as fsConstants, statSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { MemCore } from "memcore";
import type { McpRegistry } from "../mcp/registry.js";
import type { PluginHost } from "../plugins/host.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SubagentPool } from "../subagents/pool.js";
import type { RoutineScheduler } from "../routines/scheduler.js";
import type { SessionStore } from "../db/sessions.js";
import type { DatabaseHandle } from "../db/index.js";
import type { Logger } from "../logger.js";
import { CORE_DIR, CORE_FILES } from "../agent-prompt.js";
import type { ConfigBackend } from "@squad/tools";
import type { Check, Diagnosis } from "./types.js";

/** Truncate a list of human-readable lines to `max` and append "+N more". */
function truncate(lines: string[], max = 5): string {
  if (lines.length <= max) return lines.join("\n");
  return [...lines.slice(0, max), `- … +${lines.length - max} more`].join("\n");
}

/**
 * Snapshot of the resolution outcome we need from `resolveProviderConfig`.
 * We accept the relevant slice rather than the whole result so the doctor
 * doesn't pull config-shape types into every check.
 */
export interface LlmResolutionSnapshot {
  primaryModel: string | null;
  configuredProviders: string[];
  resolvedProviders: string[];
  missingKeys: Array<{ provider: string; envVar: string | null; reason: string }>;
}

export interface BuiltinDeps {
  logger: Logger;
  /** SQLite handle used for the integrity check. */
  db: DatabaseHandle;
  sessions: SessionStore;
  /** Memcore instance — checked via `ping()`. */
  memcore: MemCore;
  /** Whether the OpenAI embedder key was present at boot. */
  embedderKeyPresent: boolean;
  containerTag: string;
  squadName: string;
  workspaceDir: string;
  dataDir: string;
  llm: () => LlmResolutionSnapshot;
  plugins: PluginHost;
  /** Configured plugin entries from config.plugins (path + optional config). */
  configuredPlugins: () => Array<{ path: string }>;
  /** Plugin sources that failed to load at boot or via `reload()`. */
  pluginFailures: () => Array<{ source: string; error: string }>;
  mcp: McpRegistry;
  /** Configured mcp servers from config.mcp.servers. */
  configuredMcpServers: () => Array<{ id: string }>;
  /** MCP server ids that failed to load at boot. */
  mcpFailures: () => Array<{ id: string; error: string }>;
  channels: ChannelRegistry;
  subagents: { pool: SubagentPool; limits: { maxConcurrentGlobal: number; maxTreeDepth: number } };
  routines: { scheduler: RoutineScheduler; isRunning: () => boolean };
  /**
   * Optional config-file backend. When present, fixes that need to mutate
   * config.json (e.g. removing stale plugin entries) can do so. When absent
   * (test/ephemeral deployments), those fixes report what they would do but
   * mark themselves as not applied.
   */
  configBackend?: ConfigBackend;
}

/** Helpers ------------------------------------------------------------------ */

function ok(id: string, title: string, message: string, detail?: Record<string, unknown>): Diagnosis {
  return { id, title, severity: "ok", message, fixable: false, ...(detail ? { detail } : {}) };
}

function warn(
  id: string,
  title: string,
  message: string,
  opts: { detail?: Record<string, unknown>; fixable?: boolean; remediation?: string } = {},
): Diagnosis {
  return {
    id,
    title,
    severity: "warn",
    message,
    fixable: opts.fixable ?? false,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.remediation ? { remediation: opts.remediation } : {}),
  };
}

function err(
  id: string,
  title: string,
  message: string,
  opts: { detail?: Record<string, unknown>; fixable?: boolean; remediation?: string } = {},
): Diagnosis {
  return {
    id,
    title,
    severity: "error",
    message,
    fixable: opts.fixable ?? false,
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.remediation ? { remediation: opts.remediation } : {}),
  };
}

function isWritable(path: string): { ok: true } | { ok: false; reason: string } {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return { ok: false, reason: "not a directory" };
    accessSync(path, fsConstants.W_OK | fsConstants.R_OK);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Memory ------------------------------------------------------------------- */

function memcoreReachableCheck(deps: BuiltinDeps): Check {
  return {
    id: "memory.memcore_reachable",
    category: "memory",
    title: "MemCore database is reachable",
    async run() {
      try {
        const reached = await deps.memcore.ping();
        if (reached) {
          return ok(
            "memory.memcore_reachable",
            "MemCore database is reachable",
            "memcore.ping() returned ok",
          );
        }
        return err(
          "memory.memcore_reachable",
          "MemCore database is reachable",
          "memcore.ping() returned false — database refused the probe",
          { remediation: "verify MEMCORE_DATABASE_URL points at a running postgres" },
        );
      } catch (e) {
        return err(
          "memory.memcore_reachable",
          "MemCore database is reachable",
          `memcore.ping() threw: ${e instanceof Error ? e.message : String(e)}`,
          { remediation: "check postgres is up and the connection string is correct" },
        );
      }
    },
  };
}

function memoryEmbedderCheck(deps: BuiltinDeps): Check {
  return {
    id: "memory.embedder",
    category: "memory",
    title: "Memory embedder is configured (not stub)",
    async run() {
      if (deps.embedderKeyPresent) {
        return ok("memory.embedder", "Memory embedder is configured (not stub)", "OpenAI embedder key resolved at boot");
      }
      return warn(
        "memory.embedder",
        "Memory embedder is configured (not stub)",
        "no embedding API key — falling back to StubEmbedder. Semantic recall will be meaningless.",
        {
          remediation:
            "set the env var named by `server.memcore.embedding_api_key_env` (or change it in config) and restart",
        },
      );
    },
  };
}

function memoryContainerTagCheck(deps: BuiltinDeps): Check {
  return {
    id: "memory.container_tag",
    category: "memory",
    title: "Memory container tag matches squad name",
    async run() {
      if (!deps.containerTag) {
        return err(
          "memory.container_tag",
          "Memory container tag matches squad name",
          "container_tag is empty — every memory operation will fail",
        );
      }
      if (deps.containerTag !== deps.squadName) {
        return ok(
          "memory.container_tag",
          "Memory container tag matches squad name",
          `container_tag="${deps.containerTag}" (explicit override of squad_name="${deps.squadName}")`,
          { containerTag: deps.containerTag, squadName: deps.squadName },
        );
      }
      return ok(
        "memory.container_tag",
        "Memory container tag matches squad name",
        `container_tag matches squad_name ("${deps.containerTag}")`,
      );
    },
  };
}

/** Database ---------------------------------------------------------------- */

function dbIntegrityCheck(deps: BuiltinDeps): Check {
  return {
    id: "db.integrity",
    category: "database",
    title: "SQLite integrity check",
    async run() {
      const rows = deps.db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check: string;
      }>;
      const result = rows[0]?.integrity_check ?? "missing";
      if (result === "ok") {
        return ok("db.integrity", "SQLite integrity check", "PRAGMA integrity_check returned ok");
      }
      return err(
        "db.integrity",
        "SQLite integrity check",
        `PRAGMA integrity_check returned "${result}"`,
        {
          detail: { rows },
          remediation:
            "stop the gateway and restore the most recent backup of squad.db before continuing",
        },
      );
    },
  };
}

function dbStuckIngestCheck(deps: BuiltinDeps): Check {
  return {
    id: "db.stuck_ingest",
    category: "database",
    title: "No sessions stuck in in-flight ingest",
    dependsOn: ["db.integrity"],
    async run() {
      const row = deps.db
        .prepare("SELECT COUNT(*) AS c FROM sessions WHERE ingest_status = 'in_flight'")
        .get() as { c: number };
      if (row.c === 0) {
        return ok(
          "db.stuck_ingest",
          "No sessions stuck in in-flight ingest",
          "no sessions in ingest_status=in_flight",
        );
      }
      return warn(
        "db.stuck_ingest",
        "No sessions stuck in in-flight ingest",
        `${row.c} session(s) are stuck in ingest_status=in_flight`,
        {
          fixable: true,
          detail: { count: row.c },
          remediation: "reset stuck rows back to ingest_status=pending so the sweeper can retry",
        },
      );
    },
    async fix(diagnosis, ctx) {
      const expected = (diagnosis.detail?.count as number | undefined) ?? 0;
      if (ctx.dryRun) {
        return {
          id: "db.stuck_ingest",
          ok: true,
          applied: false,
          message: `would reset ${expected} stuck ingest row(s)`,
          changes: [`- sessions: ${expected} row(s) ingest_status in_flight → pending`],
          detail: { wouldReset: expected },
        };
      }
      const reset = deps.sessions.resetInFlightIngest();
      return {
        id: "db.stuck_ingest",
        ok: true,
        applied: true,
        message: `reset ${reset} stuck ingest row(s)`,
        changes: [`- sessions: ${reset} row(s) ingest_status in_flight → pending`],
        detail: { reset },
      };
    },
  };
}

/** LLM --------------------------------------------------------------------- */

function llmPrimaryCheck(deps: BuiltinDeps): Check {
  return {
    id: "llm.primary",
    category: "llm",
    title: "Primary LLM model is configured",
    async run() {
      const snap = deps.llm();
      if (snap.primaryModel) {
        return ok(
          "llm.primary",
          "Primary LLM model is configured",
          `primary model: ${snap.primaryModel}`,
        );
      }
      return err(
        "llm.primary",
        "Primary LLM model is configured",
        "llm.primary.model is empty — chat.send will fail until it's set",
        { remediation: "set llm.primary.model in config.json (e.g. 'anthropic/claude-sonnet-4-6')" },
      );
    },
  };
}

function llmKeysCheck(deps: BuiltinDeps): Check {
  return {
    id: "llm.keys",
    category: "llm",
    title: "Configured LLM providers have resolvable keys",
    async run() {
      const snap = deps.llm();
      if (snap.missingKeys.length === 0) {
        return ok(
          "llm.keys",
          "Configured LLM providers have resolvable keys",
          `${snap.resolvedProviders.length} provider(s) resolved`,
          { resolved: snap.resolvedProviders },
        );
      }
      const lines = snap.missingKeys.map(
        (m) => `- ${m.provider}: ${m.reason}${m.envVar ? ` (env ${m.envVar})` : ""}`,
      );
      return warn(
        "llm.keys",
        "Configured LLM providers have resolvable keys",
        `${snap.missingKeys.length} provider(s) without resolvable keys:\n${truncate(lines)}`,
        {
          detail: { missing: snap.missingKeys },
          remediation:
            "set the env var named by each provider's api_key_env (or put a literal api_key in config) and restart",
        },
      );
    },
  };
}

/** Filesystem --------------------------------------------------------------- */

function fsWorkspaceCheck(deps: BuiltinDeps): Check {
  return {
    id: "fs.workspace_writable",
    category: "filesystem",
    title: "Agent workspace directory is writable",
    async run() {
      const r = isWritable(deps.workspaceDir);
      if (r.ok) {
        return ok(
          "fs.workspace_writable",
          "Agent workspace directory is writable",
          `workspace ok at ${deps.workspaceDir}`,
        );
      }
      return err(
        "fs.workspace_writable",
        "Agent workspace directory is writable",
        `workspace not writable: ${r.reason}`,
        {
          detail: { workspaceDir: deps.workspaceDir },
          remediation: "fix permissions on the workspace dir (chmod/chown) and restart",
        },
      );
    },
  };
}

function fsDataDirCheck(deps: BuiltinDeps): Check {
  return {
    id: "fs.data_dir_writable",
    category: "filesystem",
    title: "Data directory is writable",
    async run() {
      const r = isWritable(deps.dataDir);
      if (r.ok) {
        return ok(
          "fs.data_dir_writable",
          "Data directory is writable",
          `data dir ok at ${deps.dataDir}`,
        );
      }
      return err(
        "fs.data_dir_writable",
        "Data directory is writable",
        `data dir not writable: ${r.reason}`,
        {
          detail: { dataDir: deps.dataDir },
          remediation: "fix permissions on the data dir and restart",
        },
      );
    },
  };
}

function fsCoreFilesCheck(deps: BuiltinDeps): Check {
  const coreDir = join(deps.workspaceDir, CORE_DIR);
  const required = [...CORE_FILES];
  return {
    id: "fs.core_files",
    category: "filesystem",
    title: "Agent core context files are seeded",
    // Don't seed into a workspace we can't write to.
    dependsOn: ["fs.workspace_writable"],
    async run() {
      const missing: string[] = [];
      for (const name of required) {
        try {
          statSync(join(coreDir, name));
        } catch {
          missing.push(name);
        }
      }
      if (missing.length === 0) {
        return ok(
          "fs.core_files",
          "Agent core context files are seeded",
          `${required.length} core file(s) present`,
        );
      }
      return warn(
        "fs.core_files",
        "Agent core context files are seeded",
        `${missing.length} core file(s) missing under ${coreDir}`,
        {
          fixable: true,
          detail: { missing, coreDir },
          remediation: "re-seed the core files (system prompt fragments) into the workspace",
        },
      );
    },
    async fix(diagnosis, ctx) {
      const missing = (diagnosis.detail?.missing as string[] | undefined) ?? [];
      const changes = missing.map((name) => `- seed ${join(coreDir, name)}`);
      if (ctx.dryRun) {
        return {
          id: "fs.core_files",
          ok: true,
          applied: false,
          message: `would seed ${missing.length} core file(s) under ${coreDir}`,
          changes,
          detail: { coreDir, missing },
        };
      }
      const { seedCoreFiles } = await import("../agent-prompt.js");
      seedCoreFiles(deps.workspaceDir);
      return {
        id: "fs.core_files",
        ok: true,
        applied: true,
        message: `re-seeded core files under ${coreDir}`,
        changes,
        detail: { coreDir, missing },
      };
    },
  };
}

/** Plugins ------------------------------------------------------------------ */

function pluginFailuresCheck(deps: BuiltinDeps): Check {
  return {
    id: "plugins.load_failures",
    category: "plugins",
    title: "All configured plugins loaded",
    async run() {
      const failures = deps.pluginFailures();
      if (failures.length === 0) {
        const loaded = deps.plugins.list().length;
        return ok(
          "plugins.load_failures",
          "All configured plugins loaded",
          `${loaded} plugin(s) loaded, 0 failed`,
        );
      }
      const lines = failures.map((f) => `- ${f.source}: ${f.error}`);
      return err(
        "plugins.load_failures",
        "All configured plugins loaded",
        `${failures.length} plugin(s) failed to load:\n${truncate(lines)}`,
        {
          detail: { failures },
          remediation:
            "fix the plugin source or remove it from config.plugins, then call plugins.reload or restart_gateway",
        },
      );
    },
  };
}

function pluginStaleConfigCheck(deps: BuiltinDeps): Check {
  return {
    id: "plugins.stale_config",
    category: "plugins",
    title: "config.plugins entries point at sources that exist",
    async run() {
      const entries = deps.configuredPlugins();
      const stale = entries.filter((e) => {
        // npm-style specs (no path separator, not absolute, not starting with
        // '.' or '@scope/') are out of scope — we can only check on-disk paths.
        if (!e.path.startsWith(".") && !e.path.startsWith("/") && !e.path.startsWith("@")) {
          return false;
        }
        const abs = isAbsolute(e.path) ? e.path : resolvePath(process.cwd(), e.path);
        return !existsSync(abs);
      });
      if (stale.length === 0) {
        return ok(
          "plugins.stale_config",
          "config.plugins entries point at sources that exist",
          `${entries.length} plugin entr${entries.length === 1 ? "y" : "ies"} resolved`,
        );
      }
      const lines = stale.map((s) => `- ${s.path}`);
      return warn(
        "plugins.stale_config",
        "config.plugins entries point at sources that exist",
        `${stale.length} plugin path(s) no longer exist on disk:\n${truncate(lines)}`,
        {
          fixable: deps.configBackend !== undefined,
          detail: { stale: stale.map((s) => s.path) },
          remediation: deps.configBackend
            ? "remove the stale entries from config.plugins and restart_gateway"
            : "config-file backend not available — remove the stale entries from config.plugins manually",
        },
      );
    },
    async fix(diagnosis, ctx) {
      const stale = (diagnosis.detail?.stale as string[] | undefined) ?? [];
      const changes = stale.map((p) => `- config.plugins: remove "${p}"`);
      if (!deps.configBackend) {
        return {
          id: "plugins.stale_config",
          ok: false,
          applied: false,
          message: "no config-file backend wired — cannot mutate config.json",
        };
      }
      if (ctx.dryRun) {
        return {
          id: "plugins.stale_config",
          ok: true,
          applied: false,
          message: `would remove ${stale.length} stale plugin entr${stale.length === 1 ? "y" : "ies"}`,
          changes,
        };
      }
      const cfg = await deps.configBackend.get();
      const current = Array.isArray(cfg.plugins) ? (cfg.plugins as unknown[]) : [];
      const staleSet = new Set(stale);
      const next = current.filter((entry) => {
        const path = typeof entry === "string" ? entry : (entry as { path?: string }).path;
        return typeof path !== "string" || !staleSet.has(path);
      });
      await deps.configBackend.setValue("plugins", next);
      return {
        id: "plugins.stale_config",
        ok: true,
        applied: true,
        message: `removed ${current.length - next.length} stale plugin entr${current.length - next.length === 1 ? "y" : "ies"} from config.plugins`,
        changes,
        warnings: ["restart_gateway is required for the change to take effect"],
      };
    },
  };
}

function mcpStaleConfigCheck(deps: BuiltinDeps): Check {
  return {
    id: "mcp.stale_config",
    category: "mcp",
    title: "mcp.servers entries that consistently fail to load",
    async run() {
      const failures = deps.mcpFailures();
      const configured = deps.configuredMcpServers();
      const configuredIds = new Set(configured.map((c) => c.id));
      // A "stale" MCP entry is one in config that failed at boot — same
      // surface openclaw uses for stale plugin ids. Live-running ones are fine.
      const staleIds = failures.map((f) => f.id).filter((id) => configuredIds.has(id));
      if (staleIds.length === 0) {
        return ok(
          "mcp.stale_config",
          "mcp.servers entries that consistently fail to load",
          "no consistently-failing mcp entries to clean up",
        );
      }
      const lines = staleIds.map((id) => `- ${id}`);
      return warn(
        "mcp.stale_config",
        "mcp.servers entries that consistently fail to load",
        `${staleIds.length} mcp entr${staleIds.length === 1 ? "y" : "ies"} failed at boot — fix the command or remove:\n${truncate(lines)}`,
        {
          // Only fixable when there's a config backend AND the operator
          // explicitly opts in via fix. Treat removal as a destructive op.
          fixable: deps.configBackend !== undefined,
          detail: { staleIds },
          remediation: deps.configBackend
            ? "remove the failing entries from mcp.servers (or fix the command/env) and restart_gateway"
            : "no config-file backend — fix mcp.servers manually",
        },
      );
    },
    async fix(diagnosis, ctx) {
      const stale = (diagnosis.detail?.staleIds as string[] | undefined) ?? [];
      const changes = stale.map((id) => `- mcp.servers: remove "${id}"`);
      if (!deps.configBackend) {
        return {
          id: "mcp.stale_config",
          ok: false,
          applied: false,
          message: "no config-file backend wired — cannot mutate config.json",
        };
      }
      if (ctx.dryRun) {
        return {
          id: "mcp.stale_config",
          ok: true,
          applied: false,
          message: `would remove ${stale.length} failing mcp entr${stale.length === 1 ? "y" : "ies"}`,
          changes,
        };
      }
      const cfg = await deps.configBackend.get();
      const mcpRaw = (cfg.mcp as { servers?: unknown[] } | undefined)?.servers;
      const current = Array.isArray(mcpRaw) ? mcpRaw : [];
      const staleSet = new Set(stale);
      const next = current.filter((entry) => {
        const id = (entry as { id?: string }).id;
        return typeof id !== "string" || !staleSet.has(id);
      });
      await deps.configBackend.setValue("mcp.servers", next);
      return {
        id: "mcp.stale_config",
        ok: true,
        applied: true,
        message: `removed ${current.length - next.length} failing mcp entr${current.length - next.length === 1 ? "y" : "ies"} from mcp.servers`,
        changes,
        warnings: ["restart_gateway is required for the change to take effect"],
      };
    },
  };
}

/** MCP --------------------------------------------------------------------- */

function mcpFailuresCheck(deps: BuiltinDeps): Check {
  return {
    id: "mcp.load_failures",
    category: "mcp",
    title: "All configured MCP servers loaded",
    async run() {
      const failures = deps.mcpFailures();
      const loaded = deps.mcp.list();
      if (failures.length === 0) {
        return ok(
          "mcp.load_failures",
          "All configured MCP servers loaded",
          `${loaded.length} server(s) loaded, 0 failed`,
        );
      }
      const lines = failures.map((f) => `- ${f.id}: ${f.error}`);
      return err(
        "mcp.load_failures",
        "All configured MCP servers loaded",
        `${failures.length} MCP server(s) failed to load:\n${truncate(lines)}`,
        {
          detail: { failures, loaded: loaded.map((l) => l.id) },
          remediation:
            "fix the server command/env in mcp.servers and call restart_gateway",
        },
      );
    },
  };
}

/** Channels ----------------------------------------------------------------- */

function channelsConnectedCheck(deps: BuiltinDeps): Check {
  return {
    id: "channels.connected",
    category: "channels",
    title: "Registered channels are connected",
    async run() {
      const records = deps.channels.list();
      if (records.length === 0) {
        return ok(
          "channels.connected",
          "Registered channels are connected",
          "no channels registered (gateway-only deployment)",
        );
      }
      const disconnected = records.filter((r) => !r.connected);
      if (disconnected.length === 0) {
        return ok(
          "channels.connected",
          "Registered channels are connected",
          `${records.length} channel(s) connected`,
        );
      }
      const lines = disconnected.map((c) => `- ${c.id} (${c.kind})`);
      return warn(
        "channels.connected",
        "Registered channels are connected",
        `${disconnected.length}/${records.length} channel(s) disconnected:\n${truncate(lines)}`,
        {
          detail: { disconnected: disconnected.map((c) => ({ id: c.id, kind: c.kind })) },
          remediation:
            "check the channel's auth/network (e.g. Discord bot token, network egress) and restart_gateway if needed",
        },
      );
    },
  };
}

/** Subagents ---------------------------------------------------------------- */

function subagentLimitsCheck(deps: BuiltinDeps): Check {
  return {
    id: "subagents.limits_sane",
    category: "subagents",
    title: "Subagent pool limits are sane",
    async run() {
      const lim = deps.subagents.limits;
      if (lim.maxConcurrentGlobal <= 0 || lim.maxTreeDepth <= 0) {
        return err(
          "subagents.limits_sane",
          "Subagent pool limits are sane",
          "subagent limits must be > 0; spawn_subagent will fail",
          { detail: { limits: lim } },
        );
      }
      return ok(
        "subagents.limits_sane",
        "Subagent pool limits are sane",
        `global=${lim.maxConcurrentGlobal} depth=${lim.maxTreeDepth}`,
      );
    },
  };
}

/** Routines ----------------------------------------------------------------- */

function routinesSchedulerCheck(deps: BuiltinDeps): Check {
  return {
    id: "routines.scheduler_running",
    category: "routines",
    title: "Routine scheduler is running",
    async run() {
      if (deps.routines.isRunning()) {
        return ok(
          "routines.scheduler_running",
          "Routine scheduler is running",
          "scheduler tick timer is active",
        );
      }
      return warn(
        "routines.scheduler_running",
        "Routine scheduler is running",
        "scheduler is stopped — cron routines will not fire",
        {
          fixable: true,
          remediation: "start the scheduler (calls scheduler.start())",
        },
      );
    },
    async fix(_diagnosis, ctx) {
      if (ctx.dryRun) {
        return {
          id: "routines.scheduler_running",
          ok: true,
          applied: false,
          message: "would start the routine scheduler",
          changes: ["- RoutineScheduler.start()"],
        };
      }
      deps.routines.scheduler.start();
      return {
        id: "routines.scheduler_running",
        ok: true,
        applied: true,
        message: "scheduler started",
        changes: ["- RoutineScheduler.start()"],
      };
    },
  };
}

/** Factory ------------------------------------------------------------------ */

export function createBuiltinChecks(deps: BuiltinDeps): Check[] {
  return [
    memcoreReachableCheck(deps),
    memoryEmbedderCheck(deps),
    memoryContainerTagCheck(deps),
    dbIntegrityCheck(deps),
    dbStuckIngestCheck(deps),
    llmPrimaryCheck(deps),
    llmKeysCheck(deps),
    fsWorkspaceCheck(deps),
    fsDataDirCheck(deps),
    fsCoreFilesCheck(deps),
    pluginFailuresCheck(deps),
    pluginStaleConfigCheck(deps),
    mcpFailuresCheck(deps),
    mcpStaleConfigCheck(deps),
    channelsConnectedCheck(deps),
    subagentLimitsCheck(deps),
    routinesSchedulerCheck(deps),
  ];
}
