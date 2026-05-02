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
  registerRestartTool,
  registerSquadDoctorTool,
} from "@squad/tools";
import { JsonConfigBackend } from "./config-backend.js";
import { RestartManager } from "./restart/manager.js";
import { recoverInFlightRuns } from "./restart/recovery.js";
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
import { PluginRouteRegistry } from "./plugins/http-routes.js";
import { RoutineScheduler } from "./routines/scheduler.js";
import { RoutineStore } from "./routines/store.js";
import { CronExecutor } from "./routines/executor.js";
import { DeliveryRegistry } from "./routines/delivery.js";
import { ensureCronPaths, pruneOrphanedRunLogs } from "./routines/persistence.js";
import { cronBackendFor } from "./routines/backend.js";
import { ToolsetRegistry } from "./toolsets/registry.js";
import { CommandRegistry } from "./commands/registry.js";
import { ApprovalStore } from "./approvals/store.js";
import { ApprovalRuleStore, allowListPolicy } from "./approvals/rules.js";
import { JsonFileApprovalRulePersistence } from "./approvals/rules-persist.js";
import { installApprovalHook } from "./approvals/hook.js";
import { installTraceHook, TraceSessionRegistry } from "./traces.js";
import { createHttpApiHandler } from "./http-api.js";
import { McpRegistry } from "./mcp/registry.js";
import { SubagentRuntimeRegistry } from "./subagents/runtime.js";
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
import {
  createClient,
  createModelChain,
  inferProvider,
  type LLMClient,
} from "@squad/llm";
import { resolveProviderConfig } from "./llm-config.js";
import { RotatingLLMClient, shouldRotateKeys } from "./rotating-client.js";
import { createGatewayServer, type GatewayHandle } from "./server.js";
import { seedCoreFiles } from "./agent-prompt.js";
import { memoryBackendFor } from "./memory/backend.js";
import { MemoryLLMRouter } from "./memory/llm-router.js";
import { resolveMemoryEmbedder } from "./memory/embedder-resolver.js";
import { MemoryService } from "./memory/service.js";
import { SessionIngestionService } from "./memory/session-ingest.js";
import { Doctor } from "./doctor/engine.js";
import { createBuiltinChecks } from "./doctor/checks.js";
import { doctorBackendFor } from "./doctor/backend.js";
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
export { PluginRouteRegistry } from "./plugins/http-routes.js";
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
export {
  ApprovalRuleStore,
  allowListPolicy,
  targetFromInput,
} from "./approvals/rules.js";
export {
  JsonFileApprovalRulePersistence,
  MemoryApprovalRulePersistence,
  type ApprovalRulePersistence,
} from "./approvals/rules-persist.js";
export { ChannelRegistry } from "./channels/registry.js";
export { PeerSource } from "./peers/source.js";
export { PairingStore } from "./auth/pairing.js";
export {
  JsonFilePairingPersistence,
  MemoryPairingPersistence,
  type PairingPersistence,
  type PersistedPairing,
} from "./auth/pairing-persist.js";
export {
  RestartManager,
  RestartUnsupportedError,
  SQUAD_RESTART_EXIT_CODE,
  detectRespawnGuarantee,
} from "./restart/manager.js";
export { runSupervisor } from "./restart/supervisor.js";
export {
  recoverInFlightRuns,
  repairTrailingToolUse,
  type RecoveryResult,
} from "./restart/recovery.js";
export { tagMatchPolicy, allowAllPolicy, denyAllPolicy, cascade } from "./approvals/policy.js";
export { RotatingLLMClient, shouldRotateKeys } from "./rotating-client.js";
export { McpRegistry } from "./mcp/registry.js";
export { McpClient } from "./mcp/client.js";
export { createMcpServer } from "./mcp/server.js";
export {
  SubagentRuntimeRegistry,
  type SubagentRuntime,
  type SubagentRuntimeRunInput,
  type SubagentRuntimeRunResult,
} from "./subagents/runtime.js";
export { stdioRuntime } from "./subagents/runtime-stdio.js";
export {
  discoverContextFiles,
  discoverProgressiveContextFiles,
  renderContextFilesSection,
  CONTEXT_FILE_NAMES,
} from "./context-discovery.js";
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
  Doctor,
  createBuiltinChecks,
  doctorBackendFor,
  type Check,
  type Diagnosis,
  type DoctorReport,
  type FixOutcome,
  type Severity,
  type BuiltinDeps as DoctorBuiltinDeps,
  type LlmResolutionSnapshot,
} from "./doctor/index.js";
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
   * Drives the agent's `restart_gateway` tool. Schedules a graceful close
   * followed by `process.exit(75)`; the supervisor (or external orchestrator)
   * respawns the process.
   */
  restart: RestartManager;
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
      const baseClient: LLMClient =
        fallbackModels.length > 0
          ? (createModelChain({
              primary: config.llm.primary.model,
              fallbacks: fallbackModels,
              config: llmResolution.clientConfig,
            }) as unknown as LLMClient)
          : createClient(config.llm.primary.model, llmResolution.clientConfig);
      // Wrap in a key-rotating client when any provider has 2+ keys configured.
      if (shouldRotateKeys(llmResolution.keyPools)) {
        const rotating = new RotatingLLMClient({
          pools: llmResolution.keyPools,
          buildClient: (provider, key) =>
            createClient(`${provider}/probe`, {
              keys: { [provider]: { keys: [{ key: key.key }] } },
              ...(llmResolution.clientConfig.baseUrls
                ? { baseUrls: llmResolution.clientConfig.baseUrls }
                : {}),
            }),
          logger,
          inferProvider: (model) => {
            try {
              return inferProvider(model);
            } catch {
              return null;
            }
          },
          delegate: baseClient,
        });
        const poolSummary = Object.fromEntries(
          Object.entries(llmResolution.keyPools).map(([p, keys]) => [p, keys?.length ?? 0]),
        );
        logger.info({ pools: poolSummary }, "key rotation enabled — multi-key provider pool active");
        return rotating;
      }
      return baseClient;
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

  // Registry for external subagent runtimes (Claude Code, Codex, …) that
  // plugins register via `api.subagentRuntimes.register(...)`.
  const subagentRuntimes = new SubagentRuntimeRegistry();

  const subagentPool = new SubagentPool(
    {
      registry: subagentRegistry,
      sessions,
      messages,
      toolCalls,
      broadcast,
      logger,
      toolRegistry,
      workspaceDir,
      toolsets: toolsetRegistry,
      toolGroups,
      defaultModel: config.llm.primary.model,
      runtimes: subagentRuntimes,
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
  let memcoreLlmConfigured = false;
  // Tracks whether the resolved embedder is the real OpenAI-compatible one
  // (including local providers that don't need a key) or the stub fallback.
  // The override branch never builds an embedder, so default to "openai" —
  // the doctor check is meaningful only on real boots.
  let embedderKind: import("./memory/embedder-resolver.js").EmbedderKind = "openai";
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
    // Dynamic import: memcore validates env at import-time. Loading it lazily
    // means we surface a clean error here rather than at module-resolution time.
    const memcoreMod = await import("memcore");
    const { MemCore: MemCoreCtor } = memcoreMod;
    const resolvedEmbedder = resolveMemoryEmbedder({
      embeddingModel: memcoreCfg.embedding_model,
      embeddingDim: memcoreCfg.embedding_dim,
      legacyBaseUrl: memcoreCfg.embedding_base_url,
      legacyApiKeyEnv: memcoreCfg.embedding_api_key_env,
      providers: config.llm.providers as Record<
        string,
        { api_key?: string; api_key_env?: string; base_url?: string }
      >,
      memcoreMod,
      logger,
    });
    const memcoreEmbedder = resolvedEmbedder.embedder;
    embedderKind = resolvedEmbedder.kind;
    // Resolve per-stage model: explicit override → processing_model → primary.
    // Empty string at any layer falls through; `claude-haiku-4-5` is the
    // historical extraction default and stays as a last-resort fallback so
    // existing configs without llm.primary still work.
    const primary = config.llm.primary?.model ?? "";
    const fallback = memcoreCfg.processing_model || primary || "claude-haiku-4-5";
    const stageModel = (override: string): string => override || fallback;

    // Memory LLM router: routes per-call to the right provider. Default-
    // provider calls reuse `sharedClient` (rotation/fallbacks); calls naming
    // a model from any other provider build their own client from the same
    // `llm.providers` config the chat client uses.
    const memoryLlmClient = new MemoryLLMRouter({
      defaultModel: primary,
      ...(sharedClient ? { defaultClient: sharedClient } : {}),
      clientConfig: llmResolution.clientConfig,
    });
    memcoreLlmConfigured = true;

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
      abstainSimilarityFloor: memcoreCfg.abstain_similarity_floor,
      llmClient: memoryLlmClient,
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
  // (tests inject a stub MemCore that doesn't implement extraction).
  // Otherwise it always runs — the memory router routes per-call to the
  // right provider, so there's no longer a "no LLM, skip extraction" mode.
  const ingestCfg = memcoreCfg.ingest;
  const recoveredIngestSessions = sessions.resetInFlightIngest();
  if (recoveredIngestSessions > 0) {
    logger.info(
      { count: recoveredIngestSessions },
      "reset in-flight session ingest jobs from previous run",
    );
  }
  const sessionIngestion =
    !opts.memcoreOverride && memcoreLlmConfigured
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

  // Restart manager: drives the agent's `restart_gateway` tool. We construct
  // it now so it can be injected into the tool registry, but `close` is
  // defined further down — hold a ref and fill it in once `close` exists.
  const closeRef: { current: (() => Promise<void>) | null } = { current: null };
  const restartManager = new RestartManager({
    logger,
    broadcast,
    close: async () => {
      if (closeRef.current) await closeRef.current();
    },
  });
  registerRestartTool(toolRegistry, restartManager);

  const deliveryQueue = new DeliveryQueue({
    maxQueued: config.chat.delivery.max_queued,
    collapseDuplicates: config.chat.delivery.collapse_duplicates,
  });
  const coordinator = new RunCoordinator({
    queue: deliveryQueue,
    sessions,
    logger,
  });

  // When a backgrounded subagent finishes, deliver the outcome to the root
  // chat session via the same interrupt/queue path a real `chat.send` uses.
  // The parent's turn is allowed to end naturally on spawn (the LLM is told
  // to keep working with whatever else is on its plate) — this is what
  // re-engages it later, riding the user's configured delivery mode.
  subagentPool.setBackgroundOutcomeHandler((outcome) => {
    let rootId: string;
    try {
      rootId = sessions.rootId(outcome.parentSessionId);
    } catch {
      return;
    }
    // Always emit a session.wake event so subscribers (dashboards, channels)
    // can render an "agent re-engaged" affordance even if the wake doesn't
    // result in a synthetic message (nested subagent grandchildren, etc.).
    const wakeReason = outcome.succeeded ? "subagent_completed" : "subagent_failed";
    broadcast.publish(`session.wake/${rootId}`, {
      sessionId: rootId,
      reason: wakeReason,
      detail: {
        subagent: outcome.subagent,
        subagentSessionId: outcome.sessionId,
        adHoc: outcome.adHoc,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
      occurredAt: new Date().toISOString(),
    });
    // Only wake the root if it's a user-facing chat session — i.e. it has no
    // subagentDefId. Nested subagents that fired off grandchildren don't get
    // re-engaged automatically.
    const rootSession = sessions.tryGet(rootId);
    if (!rootSession || rootSession.subagentDefId) return;

    const label = outcome.adHoc
      ? outcome.name
        ? `subagent "${outcome.name}"`
        : "ad-hoc subagent"
      : `subagent "${outcome.subagent}"`;
    const status = outcome.succeeded ? "completed" : "failed";
    const body = outcome.succeeded
      ? typeof outcome.result === "string"
        ? outcome.result
        : JSON.stringify(outcome.result)
      : outcome.error ?? "unknown error";
    const text = [
      `[${label} ${status} — sessionId: ${outcome.sessionId}]`,
      "",
      body,
    ].join("\n");

    // Defer to the next tick so we don't re-enter the agent loop from inside
    // the pool's IIFE (the running-set entry is still being released).
    setImmediate(() => {
      void (async () => {
        try {
          // Persist the synthetic message + broadcast it so the dashboard /
          // CLI render it in the parent's transcript like any other user
          // message. Then hand off to the coordinator which decides whether
          // to start a fresh turn or queue/interrupt-inject onto an active
          // one based on the session's deliveryMode.
          const userMessage = messages.append({
            sessionId: rootId,
            role: "user",
            content: [{ type: "text", text }],
          });
          broadcast.publish(`chat.user_message/${rootId}`, {
            sessionId: rootId,
            message: userMessage,
          });
          await coordinator.deliverExternalMessage(rootId, [{ type: "text", text }]);
        } catch (err) {
          logger.error(
            { err, parentSessionId: outcome.parentSessionId, rootId },
            "failed to wake parent on subagent completion",
          );
        }
      })();
    });
  });

  const providers = new Map<string, LLMClient>();
  const routinesList: RoutineDescriptor[] = [];
  const skillsList: SkillDescriptor[] = [];

  // Persistent allow-list rules — backs `approvals.allow_path` from the
  // dashboard's "always allow this path" button. Loaded eagerly so the
  // policy below sees rules from previous runs on first request.
  const approvalRulesFile = join(config.server.data_dir, "approval-rules.json");
  const approvalRules = new ApprovalRuleStore(
    new JsonFileApprovalRulePersistence(approvalRulesFile),
    {
      onAdded: (rule) => broadcast.publish("approvals.rule_added", { rule }),
      onRemoved: (ruleId) => broadcast.publish("approvals.rule_removed", { ruleId }),
    },
  );

  const approvalPolicies: ApprovalPolicy[] = [
    // User-defined allow-list wins first so a matching rule short-circuits
    // any tag-match escalation below it.
    allowListPolicy(approvalRules, (sessionId) => {
      if (!sessionId) return null;
      const s = sessions.tryGet(sessionId);
      return s?.subagentDefId ?? null;
    }),
    tagMatchPolicy({
      requireForTags: () => liveConfig.current.policy.approvals.require_for_tags,
      requireForTools: () => liveConfig.current.policy.approvals.require_for_tools,
    }),
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

  const pluginRoutes = new PluginRouteRegistry(logger);
  const plugins = new PluginHost({
    toolRegistry,
    toolGroups,
    subagentRegistry,
    subagentRuntimes,
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
    registerHttpRoute: (method, path, handler) => {
      pluginRoutes.register(method, path, handler);
    },
    onPluginChanged: (rec) => broadcast.publish("plugins.changed", { plugin: rec }),
  });

  // Plugin / MCP load failures are surfaced to the doctor so the agent can
  // diagnose them post-boot instead of relying on a log scrape.
  const pluginLoadFailures: Array<{ source: string; error: string }> = [];
  for (const entry of config.plugins) {
    const pluginPath = typeof entry === "string" ? entry : entry.path;
    const pluginConfig =
      typeof entry === "string" ? {} : (entry.config as Record<string, unknown>);
    try {
      await plugins.load(pluginPath, pluginConfig);
    } catch (err) {
      logger.error({ err, pluginPath }, "failed to load plugin");
      pluginLoadFailures.push({
        source: pluginPath,
        error: err instanceof Error ? err.message : String(err),
      });
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
  // Skills with structured shape (model / tools / inputSchema set) become
  // first-class subagents named `skill:<id>`. Skills that only carry a
  // `systemPromptFragment` keep the legacy injection behavior.
  for (const skill of skillsList) {
    const isStructured =
      skill.model !== undefined ||
      (skill.tools && skill.tools.length > 0) ||
      (skill.toolsets && skill.toolsets.length > 0) ||
      skill.inputSchema !== undefined;
    if (!isStructured) continue;
    try {
      subagentRegistry.register(
        {
          name: `skill:${skill.name}`,
          description: skill.description ?? `skill ${skill.name}`,
          model: skill.model ?? config.llm.primary.model,
          tools: skill.tools ?? [],
          ...(skill.toolsets ? { toolsets: skill.toolsets } : {}),
          ...(skill.systemPrompt ? { systemPrompt: skill.systemPrompt } : {}),
          ...(skill.inputSchema ? { inputSchema: skill.inputSchema } : {}),
          ...(skill.limits ? { limits: skill.limits } : {}),
        },
        "plugin",
      );
      logger.info({ skill: skill.name }, "skill registered as subagent");
    } catch (err) {
      logger.error({ err, skill: skill.name }, "failed to register skill as subagent");
    }
  }

  // Drop run-log files for jobs that have been deleted from disk.
  pruneOrphanedRunLogs(cronPaths.runs, routineStore.ids());

  // ── MCP servers ─────────────────────────────────────────────────────
  // Each configured MCP server spawns a subprocess and imports its tools
  // into the gateway's ToolRegistry. Failures are non-fatal — the gateway
  // boots even when one server is broken; subsequent reload() can fix it.
  const mcpRegistry = new McpRegistry({ toolRegistry, logger });
  const mcpLoadFailures: Array<{ id: string; error: string }> = [];
  for (const cfg of config.mcp.servers) {
    try {
      await mcpRegistry.load(cfg);
    } catch (err) {
      logger.error({ err, serverId: cfg.id }, "failed to load mcp server");
      mcpLoadFailures.push({
        id: cfg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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

  // Trace hook: emits per-LLM-call telemetry events scoped per session.
  const traceRegistry = new TraceSessionRegistry();
  installTraceHook(getHookRegistry(), broadcast, traceRegistry, logger);

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
    cronBackendFor({
      store: routineStore,
      runner: cronRunner,
      paths: cronPaths,
      delivery: deliveryRegistry,
    }),
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

  // Squad Doctor — diagnostic engine. Every subsystem the doctor inspects
  // is constructed by this point. We bind it via the tool registry so the
  // agent can call `squad_doctor` to find/repair issues across the system.
  const doctor = new Doctor({ logger });
  doctor.registerAll(
    createBuiltinChecks({
      logger,
      db,
      sessions,
      memcore: memcoreInstance,
      embedderKind,
      containerTag,
      squadName: config.server.squad_name,
      workspaceDir,
      dataDir: config.server.data_dir,
      llm: () => {
        const snap = resolveProviderConfig(
          liveConfig.current.llm.providers as Record<
            string,
            import("./llm-config.js").ProviderConfig
          >,
        );
        return {
          primaryModel: liveConfig.current.llm.primary?.model || null,
          configuredProviders: Object.keys(liveConfig.current.llm.providers ?? {}),
          resolvedProviders: snap.resolved,
          missingKeys: snap.missingKeys,
        };
      },
      plugins,
      configuredPlugins: () =>
        liveConfig.current.plugins.map((entry) =>
          typeof entry === "string" ? { path: entry } : { path: entry.path },
        ),
      pluginFailures: () => [...pluginLoadFailures],
      mcp: mcpRegistry,
      configuredMcpServers: () =>
        liveConfig.current.mcp.servers.map((s) => ({ id: s.id })),
      mcpFailures: () => [...mcpLoadFailures],
      ...(configBackend ? { configBackend } : {}),
      channels,
      subagents: {
        pool: subagentPool,
        limits: {
          maxConcurrentGlobal: config.subagents.max_concurrent_global,
          maxTreeDepth: config.subagents.max_tree_depth,
        },
      },
      routines: {
        scheduler: routines,
        isRunning: () => routines.isRunning(),
      },
    }),
  );
  registerSquadDoctorTool(toolRegistry, doctorBackendFor(doctor));
  logger.info({ checks: doctor.list().length }, "squad doctor ready");

  // Auto-titler: kicks in once after the first user message of a session.
  // Always instantiated so the `chat.auto_title` toggle takes effect live —
  // the generator itself bails out when `enabled()` returns false.
  const titleGenerator = new (await import("./title-generator.js")).TitleGenerator({
    sessions,
    logger,
    defaultModel: config.llm.primary.model,
    enabled: () => liveConfig.current.chat.auto_title,
    configuredModel: () => liveConfig.current.chat.title_model || null,
    fallbackModel: () => liveConfig.current.chat.title_fallback_model || null,
    resolveConfig: () =>
      resolveProviderConfig(
        liveConfig.current.llm.providers as Record<
          string,
          import("./llm-config.js").ProviderConfig
        >,
      ),
  });

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
    titleGenerator,
    ...(sessionIngestion ? { sessionIngestion } : {}),
    ingestSubagents: ingestCfg.include_subagents,
    startedAt,
    version: VERSION,
    plugins,
    pluginRoutes,
    approvals,
    approvalRules,
    channels,
    routineStore,
    cronPaths,
    peers,
    pairing,
    commands: commandRegistry,
    toolsets: toolsetRegistry,
    traceRegistry,
    httpApi: createHttpApiHandler({
      authenticator,
      sessions,
      messages,
      toolCalls,
      broadcast,
      logger,
      toolRegistry,
      defaultModel: config.llm.primary.model,
      defaultFallbacks: config.llm.fallbacks.map((f) => f.model),
      workspaceDir,
      ...(memoryService ? { memory: memoryService } : {}),
      ...(sharedClient !== undefined ? { clientOverride: sharedClient } : {}),
      traceRegistry,
    }),
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

  // Boot-time recovery for chat runs: any session left in `running` from a
  // previous process gets its message tail repaired (synthetic tool_results
  // for unmatched tool_use blocks) and a fresh turn fired so the agent
  // continues where it left off. Non-fatal — errors are logged and the
  // gateway boots normally.
  //
  // This runs *after* `createGatewayServer` (which registers chat methods
  // and wires `coordinator.setStarter`) but *before* the listener is bound,
  // so resumed turns are queued through the normal coordinator path before
  // any new client traffic arrives.
  try {
    await recoverInFlightRuns({
      sessions,
      messages,
      toolCalls,
      coordinator,
      broadcast,
      logger,
      db,
    });
  } catch (err) {
    logger.error({ err }, "in-flight run recovery failed — continuing boot");
  }

  const close = async (): Promise<void> => {
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
    await mcpRegistry.stopAll();
    await handle.close();
    try {
      await memcoreInstance.close();
    } catch (err) {
      logger.error({ err }, "memcore failed to close");
    }
    db.close();
  };
  closeRef.current = close;

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
    restart: restartManager,
    startChannels,
    close,
  };
}
