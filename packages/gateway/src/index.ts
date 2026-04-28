import { join, isAbsolute, resolve as resolvePath } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ToolRegistry,
  BUILTIN_TOOLS,
  registerTaskTools,
  registerAskUserTool,
  registerSpawnSubagentTool,
  registerConfigTools,
  registerMemoryTools,
} from "@squad/tools";
import { JsonConfigBackend } from "./config-backend.js";
import { logger } from "./logger.js";
import { resolveTokenSecrets, configSchema, type Config } from "./config.js";
import { Authenticator } from "./auth.js";
import { Broadcast } from "./broadcast.js";
import { openDb } from "./db/index.js";
import { SessionStore } from "./db/sessions.js";
import { MessageStore } from "./db/messages.js";
import { ToolCallStore } from "./db/tool-calls.js";
import { TaskStore } from "./tasks/store.js";
import { taskBackendFor } from "./tasks/backend.js";
import { QuestionStore } from "./questions/store.js";
import { questionBackendFor } from "./questions/backend.js";
import { SubagentRegistry } from "./subagents/registry.js";
import { SubagentPool } from "./subagents/pool.js";
import { subagentBackendFor } from "./subagents/backend.js";
import { DeliveryQueue } from "./delivery/queue.js";
import { RunCoordinator } from "./delivery/coordinator.js";
import { PluginHost } from "./plugins/host.js";
import { RoutineScheduler } from "./routines/scheduler.js";
import { RoutineStore } from "./routines/store.js";
import { ApprovalStore } from "./approvals/store.js";
import { ChannelRegistry } from "./channels/registry.js";
import { PeerSource } from "./peers/source.js";
import { PairingStore } from "./auth/pairing.js";
import { JsonFilePairingPersistence } from "./auth/pairing-persist.js";
import { tagMatchPolicy, cascade } from "./approvals/policy.js";
import type {
  ApprovalPolicy,
  ChannelHandle,
  RoutineDescriptor,
  SkillDescriptor,
} from "@squad/plugin-sdk";
import { createClient, createModelChain, type LLMClient } from "@squad/llm";
import { resolveProviderConfig } from "./llm-config.js";
import { createGatewayServer, type GatewayHandle } from "./server.js";
import { seedCoreFiles } from "./agent-prompt.js";
import { MemoryStore } from "./memory/store.js";
import { resolveMemoryDir } from "./memory/files.js";
import { memoryBackendFor } from "./memory/backend.js";
import { MemoryService } from "./memory/service.js";

export { logger } from "./logger.js";
export { loadConfig, type Config } from "./config.js";
export { JsonConfigBackend } from "./config-backend.js";
export { createGatewayServer } from "./server.js";
export { Broadcast } from "./broadcast.js";
export { Authenticator } from "./auth.js";
export { openDb } from "./db/index.js";
export { SessionStore } from "./db/sessions.js";
export { MessageStore } from "./db/messages.js";
export { ToolCallStore } from "./db/tool-calls.js";
export { TaskStore } from "./tasks/store.js";
export { taskBackendFor } from "./tasks/backend.js";
export { QuestionStore } from "./questions/store.js";
export { questionBackendFor } from "./questions/backend.js";
export { SubagentRegistry } from "./subagents/registry.js";
export { SubagentPool } from "./subagents/pool.js";
export { subagentBackendFor } from "./subagents/backend.js";
export { DeliveryQueue } from "./delivery/queue.js";
export { RunCoordinator } from "./delivery/coordinator.js";
export { PluginHost } from "./plugins/host.js";
export { RoutineScheduler, matchesCron } from "./routines/scheduler.js";
export { RoutineStore } from "./routines/store.js";
export { ApprovalStore } from "./approvals/store.js";
export { ChannelRegistry } from "./channels/registry.js";
export { PeerSource } from "./peers/source.js";
export { PairingStore } from "./auth/pairing.js";
export {
  JsonFilePairingPersistence,
  MemoryPairingPersistence,
  type PairingPersistence,
  type PersistedPairing,
} from "./auth/pairing-persist.js";
export { tagMatchPolicy, allowAllPolicy, denyAllPolicy, cascade } from "./approvals/policy.js";
export { Dispatcher } from "./dispatch/index.js";
export { runChatTurn } from "./runs.js";
export {
  buildSquadSystemPrompt,
  loadCoreFiles,
  seedCoreFiles,
  CORE_DIR,
  CORE_FILES,
} from "./agent-prompt.js";
export {
  MemoryStore,
  MemoryService,
  resolveMemoryDir,
  memoryBackendFor,
  DuplicateMemoryError,
  MemoryValidationError,
  MEMORY_TYPES,
  MEMORY_SCOPES,
  MEMORY_BODY_BUDGET,
  EAGER_BLOCK_BUDGET,
  type MemoryEntry,
  type MemoryType,
  type MemoryScope,
  type MemoryStatus,
  type MemoryProposeInput,
  type MemoryUpdateInput,
  type MemorySearchInput,
  type MemorySearchHit,
} from "./memory/index.js";

export const VERSION = "0.0.0";

export interface BootOptions {
  config: Config;
  toolRegistry?: ToolRegistry;
  /**
   * Absolute path to the config.json file. When set, the agent gets
   * `get_config` / `set_config` / `unset_config` / `list_config_paths`
   * tools that persist edits back to this file. Omit to disable the
   * config tools (tests, ephemeral deployments).
   */
  configPath?: string;
  /** Testing seam: inject an LLMClient to bypass real provider calls. */
  clientOverride?: LLMClient;
}

export interface BootedGateway {
  handle: GatewayHandle;
  stores: {
    sessions: SessionStore;
    messages: MessageStore;
    toolCalls: ToolCallStore;
    tasks: TaskStore;
    questions: QuestionStore;
    memory: MemoryStore;
    approvals: ApprovalStore;
    routines: RoutineStore;
  };
  subagents: {
    pool: SubagentPool;
    registry: SubagentRegistry;
  };
  plugins: PluginHost;
  routines: RoutineScheduler;
  routineStore: RoutineStore;
  channels: ChannelRegistry;
  peers: PeerSource;
  pairing: PairingStore;
  coordinator: RunCoordinator;
  deliveryQueue: DeliveryQueue;
  broadcast: Broadcast;
  /**
   * Start every channel lifecycle registered by a plugin. Called after the
   * HTTP/WS server is listening — channels typically dial back to the gateway
   * over WebSocket, so the listener must be up first. Failures are logged and
   * swallowed so one bad channel can't keep the gateway from coming up.
   */
  startChannels: () => Promise<void>;
  close: () => Promise<void>;
}

export async function boot(opts: BootOptions): Promise<BootedGateway> {
  const startedAt = Date.now();
  // Re-parse through configSchema so callers that pass partial literals get
  // sensible defaults (chat.delivery, etc.). Idempotent for already-parsed
  // values. Held in a mutable ref so config-tool edits are visible to code
  // that reads `liveConfig.current` later in the process lifetime.
  const liveConfig: { current: Config } = {
    current: configSchema.parse(opts.config) as Config,
  };
  const config = liveConfig.current;

  const dbPath = join(config.server.data_dir, "squad.db");
  const db = openDb({ path: dbPath });

  // Resolve the agent's persistent home directory and ensure it exists.
  // Empty config value means "derive from data_dir" so test fixtures that
  // tmpdir their data_dir get an isolated workspace for free.
  const rawWorkspace = config.server.workspace_dir || join(config.server.data_dir, "workspace");
  const workspaceDir = isAbsolute(rawWorkspace)
    ? rawWorkspace
    : resolvePath(process.cwd(), rawWorkspace);
  mkdirSync(workspaceDir, { recursive: true });
  seedCoreFiles(workspaceDir);
  logger.info({ workspaceDir }, "agent workspace ready");

  const sessions = new SessionStore(db, {
    deliveryMode: config.chat.delivery.mode,
  });
  const messages = new MessageStore(db);
  const toolCalls = new ToolCallStore(db);
  const broadcast = new Broadcast();
  const tokens = resolveTokenSecrets(config);
  const authenticator = new Authenticator(tokens);
  const tasks = new TaskStore(db, sessions, {
    onCreated: (task) => broadcast.publish(`tasks.created/${task.taskListId}`, { task }),
    onUpdated: (task) => broadcast.publish(`tasks.updated/${task.taskListId}`, { task }),
    onDeleted: (task) => broadcast.publish(`tasks.deleted/${task.taskListId}`, { task }),
  });
  const questions = new QuestionStore(
    db,
    {
      onAsked: (q) => broadcast.publish(`questions.asked/${q.sessionId}`, { question: q }),
      onAnswered: (q) => broadcast.publish(`questions.answered/${q.sessionId}`, { question: q }),
      onCancelled: (q) =>
        broadcast.publish(`questions.cancelled/${q.sessionId}`, { question: q }),
      onTimedOut: (q) =>
        broadcast.publish(`questions.timed_out/${q.sessionId}`, { question: q }),
    },
    config.policy.approvals.timeout_seconds,
  );
  const toolRegistry = opts.toolRegistry ?? new ToolRegistry().registerAll([...BUILTIN_TOOLS]);
  const subagentRegistry = new SubagentRegistry();

  // Resolve provider config (api_key / api_key_env / base_url) into a
  // ClientConfig and build a single primary+fallback client we hand to
  // every code path that needs to talk to a model. Without this, the
  // runner builds clients with just env-var fallbacks — which silently
  // fails when callers configure keys via JSON instead of `process.env`.
  const llmResolution = resolveProviderConfig(
    config.llm.providers as Record<string, import("./llm-config.js").ProviderConfig>,
  );
  const sharedClient: LLMClient | undefined = (() => {
    if (opts.clientOverride) return opts.clientOverride;
    if (!config.llm.primary?.model) return undefined;
    try {
      const fallbackModels = config.llm.fallbacks.map((f) => f.model);
      if (fallbackModels.length > 0) {
        return createModelChain({
          primary: config.llm.primary.model,
          fallbacks: fallbackModels,
          config: llmResolution.clientConfig,
        }) as unknown as LLMClient;
      }
      return createClient(config.llm.primary.model, llmResolution.clientConfig);
    } catch (err) {
      logger.error(
        { err, primary: config.llm.primary.model },
        "could not build shared LLM client — chat.send will surface the error per-turn",
      );
      return undefined;
    }
  })();
  if (llmResolution.missingKeys.length > 0) {
    for (const m of llmResolution.missingKeys) {
      logger.warn(
        { provider: m.provider, envVar: m.envVar, reason: m.reason },
        `LLM provider "${m.provider}" has no resolvable api key — calls to its models will fail`,
      );
    }
  }
  if (llmResolution.resolved.length > 0) {
    logger.info({ providers: llmResolution.resolved }, "LLM providers resolved");
  }

  const subagentPool = new SubagentPool(
    {
      registry: subagentRegistry,
      sessions,
      broadcast,
      logger,
      toolRegistry,
      workspaceDir,
      ...(sharedClient !== undefined ? { clientOverride: sharedClient } : {}),
    },
    {
      maxConcurrentGlobal: config.subagents.max_concurrent_global,
      maxConcurrentPerParent: config.subagents.max_concurrent_per_parent,
      maxTreeDepth: config.subagents.max_tree_depth,
    },
  );
  registerTaskTools(toolRegistry, taskBackendFor(tasks));
  registerAskUserTool(toolRegistry, questionBackendFor(questions));
  registerSpawnSubagentTool(toolRegistry, subagentBackendFor(subagentPool, subagentRegistry));

  // Memory store: durable typed entries that follow the user across docker
  // re-rolls. Lives at ~/.squad/memory/ by default — deliberately NOT under
  // data_dir/workspace_dir.
  const memoryDir = resolveMemoryDir(config.server.memory_dir);
  mkdirSync(memoryDir, { recursive: true });
  const memory = new MemoryStore(db, { memoryDir });
  registerMemoryTools(toolRegistry, memoryBackendFor(memory));
  const memoryService = new MemoryService(memory);
  logger.info({ memoryDir }, "memory store ready");

  // Single ConfigBackend feeds both the agent's `set_config` tools AND the
  // dashboard's `admin.config.set` RPC, so writes from either side stay in
  // sync (and the validation-on-write contract is honored once).
  const configBackend = opts.configPath
    ? new JsonConfigBackend({
        path: opts.configPath,
        onUpdate: (next) => {
          liveConfig.current = next;
        },
      })
    : undefined;
  if (configBackend) {
    registerConfigTools(toolRegistry, configBackend);
  }

  const deliveryQueue = new DeliveryQueue({
    maxQueued: config.chat.delivery.max_queued,
    collapseDuplicates: config.chat.delivery.collapse_duplicates,
  });
  const coordinator = new RunCoordinator({
    queue: deliveryQueue,
    sessions,
    logger,
  });

  const providers = new Map<string, LLMClient>();
  const routinesList: RoutineDescriptor[] = [];
  const skillsList: SkillDescriptor[] = [];
  const approvalPolicies: ApprovalPolicy[] = [
    tagMatchPolicy({ requireForTags: config.policy.approvals.require_for_tags }),
  ];
  const channelHandles: ChannelHandle[] = [];
  void cascade; // exported, not wired into a ToolRegistry seam yet

  const channels = new ChannelRegistry({
    onChannelChanged: (rec) => broadcast.publish("channels.changed", { channel: rec }),
  });
  const approvals = new ApprovalStore({
    onPending: (a) => broadcast.publish(`approvals.pending/${a.sessionId}`, { approval: a }),
    onDecided: (a) => broadcast.publish(`approvals.decided/${a.sessionId}`, { approval: a }),
  });
  const routineStore = new RoutineStore({
    onFired: (e) => broadcast.publish(`routines.fired/${e.sessionId}`, e),
  });

  const plugins = new PluginHost({
    toolRegistry,
    subagentRegistry,
    logger,
    providers,
    routines: routinesList,
    skills: skillsList,
    approvalPolicies,
    channels: channelHandles,
    onPluginChanged: (rec) => broadcast.publish("plugins.changed", { plugin: rec }),
  });

  for (const entry of config.plugins) {
    const pluginPath = typeof entry === "string" ? entry : entry.path;
    const pluginConfig =
      typeof entry === "string" ? {} : (entry.config as Record<string, unknown>);
    try {
      await plugins.load(pluginPath, pluginConfig);
    } catch (err) {
      logger.error({ err, pluginPath }, "failed to load plugin");
    }
  }

  // After plugins finish loading, register their channels in the registry
  // and adopt their routines into the dashboard-visible routine store.
  for (const ch of channelHandles) channels.add(ch);
  for (const r of routinesList) routineStore.adoptFromPlugin(r);

  const routines = new RoutineScheduler(
    async (r) => {
      logger.info({ routine: r.name }, "routine fired");
      const session = sessions.create({
        model: r.model ?? config.llm.primary.model,
        fallbacks: config.llm.fallbacks.map((f) => f.model),
        title: `routine:${r.name}`,
      });
      // Tie the cron-fired session back to the routine record so dashboards
      // can show "last run" / link to the session that ran it.
      const rec = routineStore.list().find((rr) => rr.name === r.name);
      if (rec) routineStore.markFired(rec.id, session.id);
      // Phase 10 runs the routine prompt through the agent loop via the
      // existing runChatTurn path. Delivery lands in the broadcast stream;
      // channel-specific delivery is a post-v1 refinement.
      void session;
    },
    logger,
  );
  for (const r of routinesList) routines.register(r);

  // Persist approved browser pairings to <data_dir>/pairings.json so a
  // gateway restart doesn't force every browser to re-pair.
  const pairingsFile = join(config.server.data_dir, "pairings.json");
  const pairingPersistence = new JsonFilePairingPersistence(pairingsFile);
  const pairing = new PairingStore(
    authenticator,
    {
      onRequested: (p) => broadcast.publish("pair.requested", { pairing: p }),
      onApproved: (p) => broadcast.publish("pair.approved", { pairing: p }),
      onCancelled: (p) => broadcast.publish("pair.cancelled", { pairing: p }),
    },
    { persistence: pairingPersistence },
  );
  const restored = pairing.hydrate();
  if (restored > 0) {
    logger.info({ restored, pairingsFile }, "restored persisted browser pairings");
  }

  const peers = new PeerSource({
    selfName: config.server.squad_name,
    selfPort: config.server.port,
    selfHost: config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host,
  });
  peers.start((next) => broadcast.publish("peers.changed", { peers: next }));

  // Probe for the dashboard up front so a missing build is loud, not a
  // mystery 404 in the browser. The HTTP layer re-resolves on every
  // request, so this is informational only.
  {
    const probe = await import("./server.js").then((m) => m.dashboardRootForLogging());
    if (probe) logger.info({ dashboardDir: probe }, "dashboard ready");
    else
      logger.warn(
        "dashboard not built — `pnpm -F @squad/dashboard build` (or set SQUAD_DASHBOARD_DIR) to enable the SPA at /",
      );
  }

  const handle = createGatewayServer({
    config,
    logger,
    authenticator,
    broadcast,
    sessions,
    messages,
    toolCalls,
    tasks,
    questions,
    subagentPool,
    subagentRegistry,
    coordinator,
    toolRegistry,
    workspaceDir,
    memory: memoryService,
    startedAt,
    version: VERSION,
    plugins,
    approvals,
    channels,
    routineStore,
    peers,
    pairing,
    ...(sharedClient !== undefined ? { clientOverride: sharedClient } : {}),
    ...(configBackend ? { configBackend } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    liveConfigSnapshot: () => liveConfig.current as unknown as Record<string, unknown>,
    routineRunner: async (record) => {
      const session = sessions.create({
        model: record.model ?? config.llm.primary.model,
        fallbacks: config.llm.fallbacks.map((f) => f.model),
        title: `routine:${record.name}`,
      });
      logger.info({ routineId: record.id, sessionId: session.id }, "routine run_now");
      return { sessionId: session.id };
    },
    ...(opts.clientOverride !== undefined ? { clientOverride: opts.clientOverride } : {}),
  });

  const startChannels = async (): Promise<void> => {
    for (const ch of channelHandles) {
      try {
        await ch.start();
        logger.info({ channel: ch.id }, "channel started");
      } catch (err) {
        logger.error({ err, channel: ch.id }, "channel failed to start");
      }
    }
  };

  return {
    handle,
    stores: { sessions, messages, toolCalls, tasks, questions, memory, approvals, routines: routineStore },
    subagents: { pool: subagentPool, registry: subagentRegistry },
    plugins,
    routines,
    routineStore,
    channels,
    peers,
    pairing,
    coordinator,
    deliveryQueue,
    broadcast,
    startChannels,
    close: async () => {
      routines.stop();
      peers.stop();
      for (const ch of channelHandles) {
        try {
          await ch.stop();
        } catch (err) {
          logger.error({ err, channel: ch.id }, "channel failed to stop");
        }
      }
      await handle.close();
      db.close();
    },
  };
}
