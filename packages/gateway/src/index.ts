import { join, isAbsolute, resolve as resolvePath } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ToolRegistry,
  BUILTIN_TOOLS,
  BUILTIN_GROUPS,
  ToolGroupRegistry,
  DescribeToolGroupTool,
  registerTaskTools,
  registerAskUserTool,
  registerSpawnSubagentTool,
  registerConfigTools,
  registerMemoryTools,
  registerCronTools,
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
import { SubagentDefStore } from "./db/subagent-defs.js";
import { DeliveryQueue } from "./delivery/queue.js";
import { RunCoordinator } from "./delivery/coordinator.js";
import { PluginHost } from "./plugins/host.js";
import { RoutineScheduler } from "./routines/scheduler.js";
import { RoutineStore } from "./routines/store.js";
import { CronExecutor } from "./routines/executor.js";
import { DeliveryRegistry } from "./routines/delivery.js";
import { ensureCronPaths, pruneOrphanedRunLogs } from "./routines/persistence.js";
import { cronBackendFor } from "./routines/backend.js";
import { ToolsetRegistry } from "./toolsets/registry.js";
import { CommandRegistry } from "./commands/registry.js";
import { ApprovalStore } from "./approvals/store.js";
import { installApprovalHook } from "./approvals/hook.js";
import { getHookRegistry } from "@squad/runner";
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
  SlashCommandDescriptor,
  ToolsetDescriptor,
} from "@squad/plugin-sdk";
import { createClient, createModelChain, type LLMClient } from "@squad/llm";
import { resolveProviderConfig } from "./llm-config.js";
import { createGatewayServer, type GatewayHandle } from "./server.js";
import { seedCoreFiles } from "./agent-prompt.js";
import { memoryBackendFor } from "./memory/backend.js";
import { SquadLLMClientForMemCore } from "./memory/llm-adapter.js";
import { MemoryService } from "./memory/service.js";
import { SessionIngestionService } from "./memory/session-ingest.js";
import type { MemCore } from "memcore";

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
export { RoutineScheduler, matchesCron, computeNextRunAt, isDue } from "./routines/scheduler.js";
export { RoutineStore } from "./routines/store.js";
export { CronExecutor } from "./routines/executor.js";
export {
  ensureCronPaths,
  appendRunLog,
  readRunLog,
  staggerOffsetMs,
} from "./routines/persistence.js";
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
  MemoryService,
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
  /**
   * Testing seam: inject a MemCore instance to bypass postgres. When
   * provided, the gateway uses this instead of constructing one from
   * `config.server.memcore`.
   */
  memcoreOverride?: MemCore;
}

export interface BootedGateway {
  handle: GatewayHandle;
  stores: {
    sessions: SessionStore;
    messages: MessageStore;
    toolCalls: ToolCallStore;
    tasks: TaskStore;
    questions: QuestionStore;
    memory: MemoryService;
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
  commandRegistry: CommandRegistry;
  toolsetRegistry: ToolsetRegistry;
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
  // Bridge SessionStore mutations onto the broadcast bus so dashboards/CLI
  // clients see new and modified sessions live without polling session.list.
  sessions.onChange((kind, session) => {
    broadcast.publish(`session.${kind}`, { session });
  });
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
  const subagentDefStore = new SubagentDefStore(db);
  // Hydrate user-created subagents from sqlite. Plugin-registered subagents
  // come back via the plugin host on its own boot path.
  for (const def of subagentDefStore.list()) subagentRegistry.register(def, "user");

  // Tool groups: lazy-loading scheme that keeps the system prompt small. The
  // registry holds {name → {description, guidance, toolNames}} for every
  // built-in group; runs.ts computes the per-turn allow-list from
  // (default groups ∪ session's unlocked groups). The DescribeToolGroupTool
  // is the only meta-tool the agent calls to unlock more groups.
  const toolGroups = new ToolGroupRegistry().registerAll([...BUILTIN_GROUPS]);
  toolRegistry.register(
    new DescribeToolGroupTool(toolGroups, (sessionId, groupName) => {
      if (sessionId) sessions.unlockGroup(sessionId, groupName);
    }).toEntry(),
  );

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

  // Toolset registry is wired here so the SubagentPool can resolve any
  // toolset references at spawn time. Plugins register into it later via
  // the GatewayAPI; the registry is mutable so the reference holds.
  const toolsetRegistry = new ToolsetRegistry(toolRegistry);

  const subagentPool = new SubagentPool(
    {
      registry: subagentRegistry,
      sessions,
      broadcast,
      logger,
      toolRegistry,
      workspaceDir,
      toolsets: toolsetRegistry,
      toolGroups,
      defaultModel: config.llm.primary.model,
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
  registerSpawnSubagentTool(
    toolRegistry,
    subagentBackendFor({
      pool: subagentPool,
      registry: subagentRegistry,
      defStore: subagentDefStore,
      workspaceDir,
      defaultModel: config.llm.primary.model,
    }),
  );

  // Memory: every memory operation routes through MemCore. The gateway holds
  // no local memory state. Boot fails fast if MemCore can't be initialized —
  // memory is a load-bearing primitive for the agent, not optional.
  const memcoreCfg = config.server.memcore;
  let memcoreInstance: MemCore;
  let memcoreLlmClient: SquadLLMClientForMemCore | undefined;
  if (opts.memcoreOverride) {
    memcoreInstance = opts.memcoreOverride;
  } else {
    const memcoreDatabaseUrl =
      memcoreCfg.database_url || process.env.MEMCORE_DATABASE_URL || "";
    if (!memcoreDatabaseUrl) {
      throw new Error(
        "memcore.database_url (or MEMCORE_DATABASE_URL) is required — squad uses MemCore for all memory ops",
      );
    }
    const memcoreEmbedKey = process.env[memcoreCfg.embedding_api_key_env] ?? "";
    // Dynamic import: memcore validates env at import-time. Loading it lazily
    // means we surface a clean error here rather than at module-resolution time.
    const memcoreMod = await import("memcore");
    const { MemCore: MemCoreCtor, OpenAIEmbedder, StubEmbedder } = memcoreMod;
    const memcoreEmbedder = memcoreEmbedKey
      ? new OpenAIEmbedder({
          apiKey: memcoreEmbedKey,
          model: memcoreCfg.embedding_model,
          ...(memcoreCfg.embedding_base_url
            ? { baseUrl: memcoreCfg.embedding_base_url }
            : {}),
        })
      : (() => {
          logger.warn(
            { envVar: memcoreCfg.embedding_api_key_env },
            "memcore embedder API key not set — using StubEmbedder (semantic recall will be degraded)",
          );
          return new StubEmbedder(memcoreCfg.embedding_dim, memcoreCfg.embedding_model);
        })();
    // Resolve per-stage model: explicit override → processing_model → primary.
    // Empty string at any layer falls through; `claude-haiku-4-5` is the
    // historical extraction default and stays as a last-resort fallback so
    // existing configs without llm.primary still work.
    const primary = config.llm.primary?.model ?? "";
    const fallback = memcoreCfg.processing_model || primary || "claude-haiku-4-5";
    const stageModel = (override: string): string => override || fallback;

    memcoreLlmClient = sharedClient
      ? new SquadLLMClientForMemCore(sharedClient)
      : undefined;
    if (!memcoreLlmClient) {
      logger.warn(
        "no shared LLM client — memcore ingestion will skip extraction (chunks only)",
      );
    }
    memcoreInstance = new MemCoreCtor({
      databaseUrl: memcoreDatabaseUrl,
      embedder: memcoreEmbedder,
      embeddingModel: memcoreCfg.embedding_model,
      embeddingDim: memcoreCfg.embedding_dim,
      extractionModel: stageModel(memcoreCfg.extraction_model),
      contextualizerModel: stageModel(memcoreCfg.contextualizer_model),
      conflictModel: stageModel(memcoreCfg.conflict_model),
      temporalParserModel: stageModel(memcoreCfg.temporal_parser_model),
      profileGeneratorModel: stageModel(memcoreCfg.profile_generator_model),
      ...(memcoreLlmClient ? { llmClient: memcoreLlmClient } : {}),
    });
  }
  const containerTag = memcoreCfg.container_tag || config.server.squad_name;
  const memoryService = new MemoryService(memcoreInstance, logger, {
    containerTag,
  });
  registerMemoryTools(toolRegistry, memoryBackendFor(memoryService));
  subagentPool.setMemory(memoryService);
  logger.info({ containerTag }, "memcore memory service ready");

  // Idle-driven session ingestion. Disabled when `memcoreOverride` is set
  // (tests inject a stub MemCore that doesn't implement extraction) and when
  // there's no shared LLMClient (extraction would be a no-op anyway).
  const ingestCfg = memcoreCfg.ingest;
  const recoveredIngestSessions = sessions.resetInFlightIngest();
  if (recoveredIngestSessions > 0) {
    logger.info(
      { count: recoveredIngestSessions },
      "reset in-flight session ingest jobs from previous run",
    );
  }
  const sessionIngestion =
    !opts.memcoreOverride && memcoreLlmClient
      ? new SessionIngestionService({
          memcore: memcoreInstance,
          sessions,
          messages,
          memoryService,
          logger,
          containerTag,
          config: {
            idleThresholdSeconds: ingestCfg.idle_threshold_seconds,
            maxIdleSeconds: ingestCfg.max_idle_seconds,
            minDeltaMessages: ingestCfg.min_delta_messages,
            minDeltaTokens: ingestCfg.min_delta_tokens,
            includeSubagents: ingestCfg.include_subagents,
            sweeperIntervalSeconds: ingestCfg.sweeper_interval_seconds,
          },
        })
      : undefined;
  if (sessionIngestion) {
    sessionIngestion.start();
    logger.info(
      {
        idleThresholdSeconds: ingestCfg.idle_threshold_seconds,
        sweeperIntervalSeconds: ingestCfg.sweeper_interval_seconds,
      },
      "session ingestion sweeper started",
    );
  }

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
  const commandsList: SlashCommandDescriptor[] = [];
  const toolsetsList: ToolsetDescriptor[] = [];

  const channels = new ChannelRegistry({
    onChannelChanged: (rec) => broadcast.publish("channels.changed", { channel: rec }),
  });
  const approvals = new ApprovalStore({
    onPending: (a) => {
      broadcast.publish(`approvals.pending/${a.sessionId}`, { approval: a });
      // Mirror the design's `approvals.requested` topic — a clearer name for
      // "the runner is paused, please render an approval prompt." The
      // existing `pending` topic stays for backward-compat with subscribers
      // that already key off it.
      broadcast.publish(`approvals.requested/${a.sessionId}`, { approval: a });
    },
    onDecided: (a) => broadcast.publish(`approvals.decided/${a.sessionId}`, { approval: a }),
  });
  const cronPaths = ensureCronPaths(config.server.data_dir);
  const routineStore = new RoutineStore(
    {
      onFired: (e) =>
        broadcast.publish(`routines.fired/${e.sessionId ?? "no-session"}`, e),
      onChanged: (rec) => broadcast.publish("routines.changed", { routine: rec }),
    },
    { dataDir: config.server.data_dir },
  );
  const deliveryRegistry = new DeliveryRegistry(broadcast, logger);
  const commandRegistry = new CommandRegistry();
  commandRegistry.registerBuiltins();

  const plugins = new PluginHost({
    toolRegistry,
    subagentRegistry,
    logger,
    providers,
    routines: routinesList,
    skills: skillsList,
    approvalPolicies,
    channels: channelHandles,
    commands: commandsList,
    toolsets: toolsetsList,
    registerDelivery: (kind, handler) => {
      deliveryRegistry.register(kind, async (ctx) => handler(ctx));
    },
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
  for (const cmd of commandsList) commandRegistry.register(cmd);
  for (const ts of toolsetsList) {
    try {
      toolsetRegistry.register(ts);
    } catch (err) {
      logger.error({ err, toolset: ts.name }, "failed to register toolset");
    }
  }

  // Drop run-log files for jobs that have been deleted from disk.
  pruneOrphanedRunLogs(cronPaths.runs, routineStore.ids());

  // Wire the approval policy into the runner's before_tool_call hook.
  // Plugins may have added more policies during plugin load; cascade the
  // full list so any plugin-supplied policy that returns approve/deny wins
  // before the default tag-match one.
  installApprovalHook({
    hooks: getHookRegistry(),
    approvals,
    policy: cascade(approvalPolicies),
    toolRegistry,
    sessions,
    logger,
  });

  const cronExecutor = new CronExecutor({
    sessions,
    messages,
    toolCalls,
    broadcast,
    toolRegistry,
    logger,
    workspaceDir,
    ...(memoryService ? { memory: memoryService } : {}),
    ...(sharedClient ? { clientOverride: sharedClient } : {}),
    defaultModel: config.llm.primary.model,
    defaultFallbacks: config.llm.fallbacks.map((f) => f.model),
    paths: cronPaths,
    delivery: deliveryRegistry,
  });

  const cronRunner: import("./routines/store.js").RoutineRunner = async (record) => {
    const result = await cronExecutor.execute(record);
    return { sessionId: result.sessionId };
  };

  const routines = new RoutineScheduler(
    routineStore,
    async (rec) => {
      logger.info({ routineId: rec.id, name: rec.name }, "routine fired");
      return cronExecutor.execute(rec);
    },
    logger,
    { staggerSeed: config.server.squad_name, paths: cronPaths },
  );

  // Expose the cron CRUD as agent tools so the agent can schedule its own
  // recurring/one-shot work without going through the dispatch layer.
  registerCronTools(
    toolRegistry,
    cronBackendFor({ store: routineStore, runner: cronRunner, paths: cronPaths }),
  );

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

  // Auto-titler: kicks in once after the first user message of a session.
  // Off-by-default would mean every install has to opt in; we surface the
  // toggle via `chat.auto_title` instead and pass `undefined` here when
  // disabled so chat dispatch skips the call entirely.
  const titleGenerator = config.chat.auto_title
    ? new (await import("./title-generator.js")).TitleGenerator({
        sessions,
        logger,
        defaultModel: config.llm.primary.model,
        configuredModel: () => liveConfig.current.chat.title_model || null,
        resolveConfig: () =>
          resolveProviderConfig(
            liveConfig.current.llm.providers as Record<
              string,
              import("./llm-config.js").ProviderConfig
            >,
          ),
        ...(sharedClient ? { clientOverride: sharedClient } : {}),
      })
    : undefined;

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
    subagentDefStore,
    coordinator,
    toolRegistry,
    toolGroups,
    workspaceDir,
    memory: memoryService,
    ...(titleGenerator ? { titleGenerator } : {}),
    ...(sessionIngestion ? { sessionIngestion } : {}),
    ingestSubagents: ingestCfg.include_subagents,
    startedAt,
    version: VERSION,
    plugins,
    approvals,
    channels,
    routineStore,
    cronPaths,
    peers,
    pairing,
    commands: commandRegistry,
    toolsets: toolsetRegistry,
    ...(sharedClient !== undefined ? { clientOverride: sharedClient } : {}),
    ...(configBackend ? { configBackend } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    liveConfigSnapshot: () => liveConfig.current as unknown as Record<string, unknown>,
    routineRunner: async (record) => {
      logger.info({ routineId: record.id }, "routine run_now");
      return cronRunner(record);
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
    stores: { sessions, messages, toolCalls, tasks, questions, memory: memoryService, approvals, routines: routineStore },
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
    commandRegistry,
    toolsetRegistry,
    startChannels,
    close: async () => {
      routines.stop();
      peers.stop();
      if (sessionIngestion) await sessionIngestion.stop();
      for (const ch of channelHandles) {
        try {
          await ch.stop();
        } catch (err) {
          logger.error({ err, channel: ch.id }, "channel failed to stop");
        }
      }
      await handle.close();
      try {
        await memcoreInstance.close();
      } catch (err) {
        logger.error({ err }, "memcore failed to close");
      }
      db.close();
    },
  };
}
