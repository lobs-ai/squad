import { join, isAbsolute, resolve as resolvePath } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ToolRegistry,
  BUILTIN_TOOLS,
  registerTaskTools,
  registerAskUserTool,
  registerSpawnSubagentTool,
  registerConfigTools,
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
import { tagMatchPolicy, cascade } from "./approvals/policy.js";
import type {
  ApprovalPolicy,
  ChannelHandle,
  RoutineDescriptor,
  SkillDescriptor,
} from "@squad/plugin-sdk";
import type { LLMClient } from "@squad/llm";
import { createGatewayServer, type GatewayHandle } from "./server.js";
import { seedCoreFiles } from "./agent-prompt.js";

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
  };
  subagents: {
    pool: SubagentPool;
    registry: SubagentRegistry;
  };
  plugins: PluginHost;
  routines: RoutineScheduler;
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
  const subagentPool = new SubagentPool(
    {
      registry: subagentRegistry,
      sessions,
      broadcast,
      logger,
      toolRegistry,
      workspaceDir,
      ...(opts.clientOverride !== undefined ? { clientOverride: opts.clientOverride } : {}),
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

  if (opts.configPath) {
    const configBackend = new JsonConfigBackend({
      path: opts.configPath,
      onUpdate: (next) => {
        liveConfig.current = next;
      },
    });
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

  const plugins = new PluginHost({
    toolRegistry,
    subagentRegistry,
    logger,
    providers,
    routines: routinesList,
    skills: skillsList,
    approvalPolicies,
    channels: channelHandles,
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

  const routines = new RoutineScheduler(
    async (r) => {
      logger.info({ routine: r.name }, "routine fired");
      const session = sessions.create({
        model: r.model ?? config.llm.primary.model,
        fallbacks: config.llm.fallbacks.map((f) => f.model),
        title: `routine:${r.name}`,
      });
      // Phase 10 runs the routine prompt through the agent loop via the
      // existing runChatTurn path. Delivery lands in the broadcast stream;
      // channel-specific delivery is a post-v1 refinement.
      void session;
    },
    logger,
  );
  for (const r of routinesList) routines.register(r);

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
    startedAt,
    version: VERSION,
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
    stores: { sessions, messages, toolCalls, tasks, questions },
    subagents: { pool: subagentPool, registry: subagentRegistry },
    plugins,
    routines,
    coordinator,
    deliveryQueue,
    broadcast,
    startChannels,
    close: async () => {
      routines.stop();
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
