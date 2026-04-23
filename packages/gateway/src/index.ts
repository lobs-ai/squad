import { join } from "node:path";
import {
  ToolRegistry,
  registerTaskTools,
  registerAskUserTool,
  registerSpawnSubagentTool,
} from "@squad/tools";
import { logger } from "./logger.js";
import { loadConfig, resolveTokenSecrets, type Config } from "./config.js";
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
import { PluginHost } from "./plugins/host.js";
import { RoutineScheduler } from "./routines/scheduler.js";
import { tagMatchPolicy, cascade } from "./approvals/policy.js";
import type { ApprovalPolicy, RoutineDescriptor, SkillDescriptor } from "@squad/plugin-sdk";
import type { LLMClient } from "@squad/llm";
import { createGatewayServer, type GatewayHandle } from "./server.js";

export { logger } from "./logger.js";
export { loadConfig, type Config } from "./config.js";
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
export { PluginHost } from "./plugins/host.js";
export { RoutineScheduler, matchesCron } from "./routines/scheduler.js";
export { tagMatchPolicy, allowAllPolicy, denyAllPolicy, cascade } from "./approvals/policy.js";
export { Dispatcher } from "./dispatch/index.js";
export { runChatTurn } from "./runs.js";

export const VERSION = "0.0.0";

export interface BootOptions {
  config: Config;
  toolRegistry?: ToolRegistry;
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
  broadcast: Broadcast;
  close: () => Promise<void>;
}

export async function boot(opts: BootOptions): Promise<BootedGateway> {
  const startedAt = Date.now();
  const config = opts.config;

  const dbPath = join(config.server.data_dir, "squad.db");
  const db = openDb({ path: dbPath });

  const sessions = new SessionStore(db);
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
  const toolRegistry = opts.toolRegistry ?? new ToolRegistry();
  const subagentRegistry = new SubagentRegistry();
  const subagentPool = new SubagentPool(
    {
      registry: subagentRegistry,
      sessions,
      broadcast,
      logger,
      toolRegistry,
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

  const providers = new Map<string, LLMClient>();
  const routinesList: RoutineDescriptor[] = [];
  const skillsList: SkillDescriptor[] = [];
  const approvalPolicies: ApprovalPolicy[] = [
    tagMatchPolicy({ requireForTags: config.policy.approvals.require_for_tags }),
  ];
  void cascade; // exported, not wired into a ToolRegistry seam yet

  const plugins = new PluginHost({
    toolRegistry,
    subagentRegistry,
    logger,
    providers,
    routines: routinesList,
    skills: skillsList,
    approvalPolicies,
  });

  for (const pluginPath of config.plugins) {
    try {
      await plugins.load(pluginPath);
    } catch (err) {
      logger.error({ err, pluginPath }, "failed to load plugin");
    }
  }

  const routines = new RoutineScheduler(
    async (r) => {
      logger.info({ routine: r.name }, "routine fired");
      const session = sessions.create({
        model: r.model ?? config.llm.default_model,
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
    toolRegistry,
    startedAt,
    version: VERSION,
    ...(opts.clientOverride !== undefined ? { clientOverride: opts.clientOverride } : {}),
  });

  return {
    handle,
    stores: { sessions, messages, toolCalls, tasks, questions },
    subagents: { pool: subagentPool, registry: subagentRegistry },
    plugins,
    routines,
    broadcast,
    close: async () => {
      routines.stop();
      await handle.close();
      db.close();
    },
  };
}
