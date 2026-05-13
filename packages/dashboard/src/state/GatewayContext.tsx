import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BrowserProtocolClient, type ConnectionStatus } from "../protocol-client.js";
import type {
  ApprovalRecord,
  Execution,
  LogEntry,
  MessageRecord,
  PairingView,
  Payload,
  PeerRecord,
  PluginRecord,
  QuestionRecord,
  RoutineRecord,
  RoutineRunLog,
  Schedule,
  SessionRecord,
  SessionTarget,
  Task,
} from "@squad/protocol";

export interface SquadIdentity {
  name: string;
  port: number;
  host: string;
  build: string;
  startedAt: string | null;
  status: "healthy" | "starting" | "stopped" | "unhealthy";
  uptimeSeconds: number;
  version: string;
  activeSessions: number;
  totalSessions: number;
}

/**
 * User-facing display labels surfaced by the gateway. The chat speaker
 * tag and owner badges read these via `useBranding()` so a single config
 * flip rebrands "agent" and "you" everywhere. Falls back to the generic
 * words when the gateway hasn't reported branding yet (initial render or
 * older gateway builds). "subagent" stays a fixed literal — subagents are
 * spawned ad-hoc per task, so they don't share a single brandable name.
 */
export interface Branding {
  agentName: string;
  userName: string;
}

const DEFAULT_BRANDING: Branding = {
  agentName: "agent",
  userName: "you",
};

export interface ModelOption {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  notes?: string;
}

export interface AdminConfig {
  primary: { model: string };
  fallbacks: Array<{ model: string }>;
  providers: string[];
  subagents: {
    maxConcurrentGlobal: number;
    maxConcurrentPerParent: number;
    maxTreeDepth: number;
  };
  approvals: { requireForTags: string[]; timeoutSeconds: number };
}

/**
 * Full raw config.json contents — what the Settings forms bind to. Shape
 * mirrors `configSchema` in `packages/gateway/src/config.ts` but is left
 * loosely typed so optional defaults don't have to be re-mirrored client-side.
 */
export interface FullConfigState {
  config: Record<string, unknown>;
  /** Backend can write — false in deployments without SQUAD_CONFIG. */
  editable: boolean;
  /** Absolute path to config.json on the gateway host (for display). */
  path: string | null;
}

export interface ChannelRecord {
  id: string;
  kind: string;
  label: string;
  connected: boolean;
}

export interface SubagentTreeNode {
  sessionId: string;
  subagent: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  children: SubagentTreeNode[];
}

/**
 * Live tool-call/tool-result events captured for the active session while a
 * run is in flight. These come from the `chat.tool_call/<sid>` and
 * `chat.tool_result/<sid>` broadcast topics — the same source the CLI uses
 * for its inline tool-call output. We hold them in dashboard memory only;
 * navigating away from the session clears them, since the gateway persists
 * the tool-call audit trail in its own table.
 */
export type LiveToolEvent =
  | {
      kind: "call";
      toolCallId: string;
      name: string;
      input: unknown;
      at: string;
    }
  | {
      kind: "result";
      toolCallId: string;
      result: unknown;
      isError: boolean;
      at: string;
    };

export type ActivityKind =
  | "chat.user_message"
  | "chat.assistant_message"
  | "chat.tool_call"
  | "chat.tool_result"
  | "chat.error"
  | "tasks.created"
  | "tasks.updated"
  | "tasks.deleted"
  | "questions.asked"
  | "questions.answered"
  | "approvals.pending"
  | "approvals.decided"
  | "subagents.spawned"
  | "subagents.completed"
  | "subagents.failed"
  | "plugins.changed"
  | "routines.fired";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  sessionId: string | null;
  text: string;
  at: string;
  icon: string;
}

export interface GatewayState {
  client: BrowserProtocolClient;
  /**
   * Live WebSocket status. "open" is the steady state; "reconnecting" means
   * the socket dropped and the client is retrying with backoff — the Chat
   * banner reads this to tell the user why their send button is greyed out.
   */
  connectionStatus: ConnectionStatus;
  squad: SquadIdentity | null;
  branding: Branding;
  peers: PeerRecord[];
  config: AdminConfig | null;
  fullConfig: FullConfigState | null;
  models: ModelOption[];
  plugins: PluginRecord[];
  channels: ChannelRecord[];
  sessions: SessionRecord[];
  pendingQuestions: QuestionRecord[];
  /**
   * Every question record for the active session, regardless of status.
   * Used by the chat transcript so answered/cancelled questions stay
   * visible inline rather than disappearing the moment the user clicks
   * an option.
   */
  sessionQuestions: QuestionRecord[];
  pendingApprovals: ApprovalRecord[];
  /**
   * Every approval record for the active session, regardless of status.
   * Used by the chat transcript so decided approvals stay visible inline
   * with an "approved" / "denied" status instead of vanishing the moment
   * the user clicks a button.
   */
  sessionApprovals: ApprovalRecord[];
  routines: RoutineRecord[];
  pairings: PairingView[];
  activity: ActivityItem[];
  /**
   * Most recent chat.error from the active session — surfaced inline in
   * chat as a banner so a failing model/provider doesn't look like the
   * agent went silent. Cleared when a fresh chat.user_message lands or
   * when the user dismisses it.
   */
  chatError: { message: string; at: string } | null;
  clearChatError: () => void;
  activeSessionId: string | null;
  activeSession: SessionRecord | null;
  rootSession: SessionRecord | null;
  treeSessions: SessionRecord[];
  messages: MessageRecord[];
  /**
   * Live tool-call events for the active session. Captured from broadcast
   * topics during a run; reset when the active session changes.
   */
  liveTools: LiveToolEvent[];
  tasks: Task[];
  streaming: string;
  /**
   * True between the moment the user sends a message and the moment the agent
   * starts emitting a response. Drives the chat typing indicator.
   */
  awaitingResponse: boolean;
  subagentTree: SubagentTreeNode | null;
  setActiveSessionId: (id: string | null) => void;
  refreshSessions: () => Promise<void>;
  refreshRoutines: () => Promise<void>;
  refreshPairings: () => Promise<void>;
  sendChat: (text: string) => Promise<void>;
  /**
   * Ask the gateway to cancel the active run for the current session. The
   * agent loop honors the request cooperatively at the next safe checkpoint
   * (between LLM turns / after in-flight tool calls). Returns true when a
   * run was found to cancel, false when the session is already idle.
   */
  cancelChat: () => Promise<boolean>;
  startSession: (opts: { title?: string; model?: string; fallbacks?: string[] }) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setSessionModel: (sessionId: string, model: string, fallbacks?: string[]) => Promise<void>;
  setSessionTitleModel: (sessionId: string, titleModel: string | null) => Promise<void>;
  /**
   * Submit answers for one ask_user record. The caller must pass an answer
   * for every sub-question keyed by the question text — that's the same
   * shape the gateway persists and the agent receives.
   */
  answerQuestion: (
    questionId: string,
    answers: Record<string, string>,
  ) => Promise<void>;
  /**
   * Cancel a pending question without answering. Used by the "dismiss" affordance
   * on the Overview / chat — the agent receives a cancellation, the record drops
   * out of `pendingQuestions`, and the UI stops surfacing it.
   */
  dismissQuestion: (questionId: string) => Promise<void>;
  decideApproval: (approvalId: string, decision: "approve" | "deny", reason?: string) => Promise<void>;
  /**
   * Dismiss a pending approval. Implemented as a deny with reason="dismissed by
   * user" so the tool sees a definitive answer and stops blocking the agent.
   */
  dismissApproval: (approvalId: string) => Promise<void>;
  /**
   * Mark this (toolName, target) as "always allow" and decide the current
   * pending approval as `approve` in one round-trip. `scope` defaults to
   * "exact" — pass "tool" to allow every target for the tool.
   */
  allowApprovalPath: (approvalId: string, scope?: "exact" | "tool") => Promise<void>;
  createTask: (subject: string, description?: string) => Promise<void>;
  updateTaskStatus: (taskId: string, status: Task["status"]) => Promise<void>;
  reloadPlugin: (id: string) => Promise<void>;
  cancelPairing: (code: string) => Promise<void>;
  /** Reload the on-disk config from the gateway (Settings form sync). */
  refreshFullConfig: () => Promise<void>;
  /**
   * Persist a single config path to disk and refresh state. The value can be
   * any JSON-serializable shape — primitive, object, or array — depending on
   * which path you're writing to.
   */
  setConfigPath: (path: string, value: unknown) => Promise<void>;
  /** Remove a single config path on disk and refresh state. */
  unsetConfigPath: (path: string) => Promise<void>;
  /**
   * Create a routine. Accepts either the legacy flat shape (cron + prompt
   * + optional model) or the structured shape (schedule + payload + session
   * + execution). The dashboard form passes the structured shape.
   */
  createRoutine: (input: CreateRoutineInput) => Promise<void>;
  updateRoutine: (id: string, patch: UpdateRoutinePatch) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  runRoutine: (id: string) => Promise<{ sessionId: string | null }>;
  /** Fetch the most recent runs for a routine. Newest first. */
  fetchRoutineRuns: (
    id: string,
    opts?: { limit?: number; status?: "ok" | "error" | "skipped" },
  ) => Promise<RoutineRunLog[]>;
  /**
   * Count of error/fatal log entries the user hasn't acknowledged. The Logs
   * view calls `markLogsRead()` on mount to clear it.
   */
  unreadLogErrors: number;
  markLogsRead: () => void;
}

export type CreateRoutineInput =
  | {
      // Structured form (preferred from the dashboard).
      name: string;
      enabled?: boolean;
      schedule: Schedule;
      payload: Payload;
      session?: SessionTarget;
      execution?: Execution;
      delivery?: RoutineRecord["delivery"];
    }
  | {
      // Legacy form — still accepted by the gateway.
      name: string;
      cron: string;
      prompt: string;
      model?: string;
      delivery?: RoutineRecord["delivery"];
      enabled?: boolean;
    };

export interface UpdateRoutinePatch {
  name?: string;
  enabled?: boolean;
  schedule?: Schedule;
  payload?: Payload;
  session?: SessionTarget;
  execution?: Execution;
  delivery?: RoutineRecord["delivery"];
  // Legacy passthroughs — older flows still set these.
  cron?: string;
  prompt?: string;
  model?: string | null;
}

const GatewayContext = createContext<GatewayState | null>(null);

export function useGateway(): GatewayState {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway() must be used inside <GatewayProvider/>");
  return ctx;
}

/**
 * Convenience accessor for display labels. Equivalent to
 * `useGateway().branding`, but lets feature components import a focused hook
 * without taking a dependency on the entire gateway context.
 */
export function useBranding(): Branding {
  return useGateway().branding;
}

interface ProviderProps {
  client: BrowserProtocolClient;
  children: ReactNode;
}

const ACTIVITY_LIMIT = 80;

// Defensive request wrapper: lets us call methods that may not yet be wired
// up in the gateway (approvals.list, plugins.list, etc.) without crashing
// the whole dashboard. Returns the fallback on any failure.
async function tryRequest<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function rootIdOf(session: SessionRecord, all: SessionRecord[]): string {
  let cur: SessionRecord | undefined = session;
  while (cur && cur.parentSessionId) {
    const next: SessionRecord | undefined = all.find((s) => s.id === cur!.parentSessionId);
    if (!next) break;
    cur = next;
  }
  return cur?.id ?? session.id;
}

function activityFromEvent(topic: string, data: unknown): ActivityItem | null {
  const [kind, sessionId] = topic.split("/") as [string, string | undefined];
  const at = new Date().toISOString();
  const id = `${topic}-${Math.random().toString(36).slice(2, 8)}`;
  const d = data as Record<string, any>;
  switch (kind) {
    case "chat.tool_call":
      return { id, kind: "chat.tool_call", sessionId: sessionId ?? null, at, icon: "term", text: `tool: ${d.name ?? "call"}` };
    case "chat.tool_result":
      return { id, kind: "chat.tool_result", sessionId: sessionId ?? null, at, icon: "check", text: d.isError ? "tool errored" : "tool result" };
    case "chat.user_message":
      return { id, kind: "chat.user_message", sessionId: sessionId ?? null, at, icon: "user", text: "user message" };
    case "chat.assistant_message":
      return { id, kind: "chat.assistant_message", sessionId: sessionId ?? null, at, icon: "bot", text: "assistant turn ended" };
    case "chat.error":
      return { id, kind: "chat.error", sessionId: sessionId ?? null, at, icon: "warn", text: d.message ?? "chat error" };
    case "tasks.created":
      return { id, kind: "tasks.created", sessionId: sessionId ?? null, at, icon: "plus", text: `task created: ${d.task?.subject ?? ""}` };
    case "tasks.updated":
      return { id, kind: "tasks.updated", sessionId: sessionId ?? null, at, icon: "tasks", text: `task ${d.task?.status}: ${d.task?.subject ?? ""}` };
    case "tasks.deleted":
      return { id, kind: "tasks.deleted", sessionId: sessionId ?? null, at, icon: "x", text: `task removed` };
    case "questions.asked":
      return { id, kind: "questions.asked", sessionId: sessionId ?? null, at, icon: "ask", text: `question: ${d.question?.input?.questions?.[0]?.question ?? ""}` };
    case "questions.answered":
      return { id, kind: "questions.answered", sessionId: sessionId ?? null, at, icon: "check", text: `question answered` };
    case "approvals.pending":
      return { id, kind: "approvals.pending", sessionId: sessionId ?? d.approval?.sessionId ?? null, at, icon: "lock", text: `approval requested: ${d.approval?.toolName ?? ""}` };
    case "approvals.decided":
      return { id, kind: "approvals.decided", sessionId: sessionId ?? d.approval?.sessionId ?? null, at, icon: d.approval?.decision === "approve" ? "check" : "x", text: `approval ${d.approval?.decision}` };
    case "subagents.spawned":
      return { id, kind: "subagents.spawned", sessionId: sessionId ?? null, at, icon: "spawn", text: `subagent spawned: ${d.subagent ?? ""}` };
    case "subagents.completed":
      return { id, kind: "subagents.completed", sessionId: sessionId ?? null, at, icon: "check", text: `subagent completed` };
    case "subagents.failed":
      return { id, kind: "subagents.failed", sessionId: sessionId ?? null, at, icon: "warn", text: `subagent failed: ${d.error ?? ""}` };
    case "plugins.changed":
      return { id, kind: "plugins.changed", sessionId: null, at, icon: "plugin", text: `plugin updated: ${d.plugin?.name ?? d.plugin?.id ?? ""}` };
    case "routines.fired":
      return { id, kind: "routines.fired", sessionId: sessionId ?? null, at, icon: "spark", text: `routine fired` };
  }
  return null;
}

export function GatewayProvider({ client, children }: ProviderProps): JSX.Element {
  const [squad, setSquad] = useState<SquadIdentity | null>(null);
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [peers, setPeers] = useState<PeerRecord[]>([]);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [fullConfig, setFullConfig] = useState<FullConfigState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRecord[]>([]);
  const [sessionQuestions, setSessionQuestions] = useState<QuestionRecord[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRecord[]>([]);
  const [sessionApprovals, setSessionApprovals] = useState<ApprovalRecord[]>([]);
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [pairings, setPairings] = useState<PairingView[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("squad-active-session");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (activeSessionId) localStorage.setItem("squad-active-session", activeSessionId);
      else localStorage.removeItem("squad-active-session");
    } catch {
      // ignore
    }
  }, [activeSessionId]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [liveTools, setLiveTools] = useState<LiveToolEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streaming, setStreaming] = useState<string>("");
  const [awaitingResponse, setAwaitingResponse] = useState<boolean>(false);
  const [chatError, setChatError] = useState<{ message: string; at: string } | null>(null);
  const [subagentTree, setSubagentTree] = useState<SubagentTreeNode | null>(null);
  const [unreadLogErrors, setUnreadLogErrors] = useState<number>(0);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    () => client.getStatus(),
  );
  const subscribedRef = useRef<Set<string>>(new Set());

  const refreshSessions = useCallback(async () => {
    const { sessions: top } = await client.request("session.list", {
      parentSessionId: null,
      limit: 100,
    });
    const childLists = await Promise.all(
      top.map((s) =>
        client
          .request("session.list", { parentSessionId: s.id, limit: 100 })
          .then((r) => r.sessions)
          .catch(() => [] as SessionRecord[]),
      ),
    );
    const all: SessionRecord[] = [...top];
    for (const list of childLists) all.push(...list);
    setSessions(all);
    return all;
  }, [client]);

  const refreshPending = useCallback(async () => {
    const [qs, aps] = await Promise.all([
      tryRequest(
        () => client.request("questions.list", { status: ["pending"] }).then((r) => r.questions),
        [] as QuestionRecord[],
      ),
      tryRequest(
        () => client.request("approvals.list", { status: ["pending"] }).then((r) => r.approvals),
        [] as ApprovalRecord[],
      ),
    ]);
    setPendingQuestions(qs);
    setPendingApprovals(aps);
  }, [client]);

  // Pulls every question record (any status) for the given session so the
  // chat transcript can show both pending and answered Q/A inline. Cheap —
  // it's a single SQLite scan filtered by session.
  const refreshSessionQuestions = useCallback(
    async (sessionId: string) => {
      const list = await tryRequest(
        () =>
          client.request("questions.list", { sessionId }).then((r) => r.questions),
        [] as QuestionRecord[],
      );
      setSessionQuestions(list);
    },
    [client],
  );

  // Pulls every approval record (any status) for the given session so the
  // chat transcript can show pending and decided approvals inline.
  const refreshSessionApprovals = useCallback(
    async (sessionId: string) => {
      const list = await tryRequest(
        () =>
          client.request("approvals.list", { sessionId }).then((r) => r.approvals),
        [] as ApprovalRecord[],
      );
      setSessionApprovals(list);
    },
    [client],
  );

  const refreshPlugins = useCallback(async () => {
    const list = await tryRequest(
      () => client.request("plugins.list", {}).then((r) => r.plugins),
      [] as PluginRecord[],
    );
    setPlugins(list);
  }, [client]);

  const refreshChannels = useCallback(async () => {
    const list = await tryRequest(
      () =>
        client.request("channels.list", {}).then((r) =>
          r.channels.map((c) => ({ id: c.id, kind: c.kind, label: c.label, connected: c.connected })),
        ),
      [] as ChannelRecord[],
    );
    setChannels(list);
  }, [client]);

  const refreshRoutines = useCallback(async () => {
    const list = await tryRequest(
      () => client.request("routines.list", {}).then((r) => r.routines as RoutineRecord[]),
      [] as RoutineRecord[],
    );
    setRoutines(list);
  }, [client]);

  const refreshPairings = useCallback(async () => {
    const list = await tryRequest(
      () => client.request("admin.pair.list", {}).then((r) => r.pairings as PairingView[]),
      [] as PairingView[],
    );
    setPairings(list);
  }, [client]);

  const refreshFullConfig = useCallback(async () => {
    const result = await tryRequest(
      () => client.request("admin.config.full", {}),
      null as FullConfigState | null,
    );
    if (result) setFullConfig(result);
  }, [client]);

  // Re-read display labels from `admin.identity` and update context state.
  // Called after the user edits a `branding.*` config path so the chat
  // speaker tag, owner badges, and "needs you" cards reflect the new name
  // immediately instead of waiting for a page reload.
  const refreshBranding = useCallback(async () => {
    const identity = await tryRequest(
      () => client.request("admin.identity", {}),
      null as null | Awaited<ReturnType<typeof client.request<"admin.identity">>>,
    );
    if (identity?.branding) {
      setBranding({
        agentName: identity.branding.agentName || DEFAULT_BRANDING.agentName,
        userName: identity.branding.userName || DEFAULT_BRANDING.userName,
      });
    }
  }, [client]);

  // Persist a single path. The gateway re-validates against `configSchema`
  // and writes atomically; we then echo the returned config into local state
  // so the form reflects what's actually on disk (handy if zod normalized
  // the input, e.g. coerced a number-as-string).
  const setConfigPath = useCallback(
    async (path: string, value: unknown) => {
      const { config: next } = await client.request("admin.config.set", { path, value });
      setFullConfig((cur) =>
        cur ? { ...cur, config: next } : { config: next, editable: true, path: null },
      );
      // Branding edits drive UI labels — refetch identity so the new name
      // shows up everywhere the moment the save completes.
      if (path.startsWith("branding.")) {
        await refreshBranding();
      }
    },
    [client, refreshBranding],
  );

  const unsetConfigPath = useCallback(
    async (path: string) => {
      const { config: next } = await client.request("admin.config.unset", { path });
      setFullConfig((cur) =>
        cur ? { ...cur, config: next } : { config: next, editable: true, path: null },
      );
    },
    [client],
  );

  const refreshTreeFor = useCallback(
    async (rootId: string) => {
      const tree = await tryRequest(
        () => client.request("subagents.tree", { rootSessionId: rootId }).then((r) => r.root as SubagentTreeNode),
        null as SubagentTreeNode | null,
      );
      setSubagentTree(tree);
    },
    [client],
  );

  const refreshPeers = useCallback(async () => {
    const list = await tryRequest(
      () => client.request("admin.peers", {}).then((r) => r.peers as PeerRecord[]),
      [] as PeerRecord[],
    );
    setPeers(list);
  }, [client]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [health, cfgResult, modelResult, identity] = await Promise.all([
        tryRequest(() => client.request("admin.health", {}), null as null | Awaited<ReturnType<typeof client.request<"admin.health">>>),
        tryRequest(() => client.request("admin.config", {}), null as AdminConfig | null),
        tryRequest(() => client.request("admin.models", {}), { models: [] as ModelOption[] }),
        tryRequest(
          () => client.request("admin.identity", {}),
          null as null | Awaited<ReturnType<typeof client.request<"admin.identity">>>,
        ),
      ]);
      if (cancelled) return;

      // Port + host are derived from `window.location` rather than from
      // `admin.identity` — under docker port-mapping the gateway sees its
      // internal port (e.g. 8080) but the user is on the host port (e.g.
      // 8123). The browser knows the truth. Same for host: a gateway
      // bound to 0.0.0.0 reports "0.0.0.0", which is meaningless to show.
      const browserPort = (() => {
        if (window.location.port) return Number(window.location.port);
        return window.location.protocol === "https:" ? 443 : 80;
      })();
      const browserHost = window.location.hostname || "127.0.0.1";
      const fallbackName =
        document.querySelector('meta[name="squad-name"]')?.getAttribute("content") ?? "default";

      // `build` is only useful when it's distinguishable from the gateway
      // version — otherwise we'd just be showing the same string twice.
      const distinctBuild =
        identity?.build && identity.build !== identity.version && identity.build !== "—"
          ? identity.build
          : null;

      setSquad({
        name: identity?.name ?? fallbackName,
        port: browserPort,
        host: browserHost,
        build: distinctBuild ?? "",
        startedAt:
          identity?.startedAt ??
          (health ? new Date(Date.now() - health.uptimeSeconds * 1000).toISOString() : null),
        status: health?.ok ? "healthy" : "unhealthy",
        uptimeSeconds: health?.uptimeSeconds ?? 0,
        version: health?.version ?? identity?.version ?? "—",
        activeSessions: health?.sessions?.active ?? 0,
        totalSessions: health?.sessions?.total ?? 0,
      });
      // Older gateways without a `branding` block fall back to the generic
      // labels so the UI keeps reading "agent"/"you".
      if (identity?.branding) {
        setBranding({
          agentName: identity.branding.agentName || DEFAULT_BRANDING.agentName,
          userName: identity.branding.userName || DEFAULT_BRANDING.userName,
        });
      }
      setConfig(cfgResult);
      setModels(modelResult.models);
      await Promise.all([
        refreshSessions(),
        refreshPending(),
        refreshPlugins(),
        refreshChannels(),
        refreshPeers(),
        refreshRoutines(),
        refreshPairings(),
        refreshFullConfig(),
      ]);
      // Seed the unread badge from the buffer's tail of error/fatal entries
      // so the user sees a count immediately on first load.
      const seed = await tryRequest(
        () => client.request("logs.tail", { level: "error", limit: 200 }),
        { entries: [] as LogEntry[], sources: [] as string[] },
      );
      if (!cancelled) setUnreadLogErrors(seed.entries.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    client,
    refreshSessions,
    refreshPending,
    refreshPlugins,
    refreshChannels,
    refreshPeers,
    refreshRoutines,
    refreshPairings,
    refreshFullConfig,
  ]);

  // Track the live WebSocket status and re-sync after a reconnect. The
  // client replays subscriptions itself, so we only need to repull the
  // resting state that may have diverged while the socket was down
  // (active session messages, pending Q/A, etc.). Without this a
  // mid-disconnect agent reply would land but never make it to the UI,
  // since the client missed those event frames entirely.
  useEffect(() => {
    let prev: ConnectionStatus = client.getStatus();
    const off = client.onConnectionChange((status) => {
      setConnectionStatus(status);
      if (status === "open" && prev === "reconnecting") {
        // Reset the typing indicator — any in-flight run may have completed
        // (or errored) while we were offline; the refetch below restores truth.
        setAwaitingResponse(false);
        setStreaming("");
        void refreshSessions();
        void refreshPending();
      }
      prev = status;
    });
    return off;
  }, [client, refreshSessions, refreshPending]);

  // When the socket reconnects, repull the active session's transcript +
  // tasks so anything the agent emitted while we were offline shows up. We
  // key this on activeSessionId so switching sessions while disconnected
  // still hydrates the right one once we're back online.
  useEffect(() => {
    if (connectionStatus !== "open") return;
    if (!activeSessionId) return;
    let cancelled = false;
    void (async () => {
      const [hist, taskList] = await Promise.all([
        tryRequest(
          () => client.request("chat.history", { sessionId: activeSessionId, limit: 200 }),
          null as null | { messages: MessageRecord[] },
        ),
        tryRequest(
          () =>
            client
              .request("tasks.list", { sessionId: activeSessionId, includeDeleted: false })
              .then((r) => r.tasks as Task[]),
          null as Task[] | null,
        ),
      ]);
      if (cancelled) return;
      if (hist) setMessages(hist.messages);
      if (taskList) setTasks(taskList);
    })();
    return () => {
      cancelled = true;
    };
    // We deliberately only refire on a status transition to "open", not on
    // activeSessionId changes — the per-session loader effect already
    // handles those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus]);

  // Periodic health refresh — drives uptime + session counts in the status bar.
  useEffect(() => {
    const t = setInterval(() => {
      void tryRequest(() => client.request("admin.health", {}), null).then((h) => {
        if (!h) return;
        setSquad((cur) =>
          cur
            ? {
                ...cur,
                uptimeSeconds: h.uptimeSeconds,
                activeSessions: h.sessions.active,
                totalSessions: h.sessions.total,
                status: h.ok ? "healthy" : "unhealthy",
              }
            : cur,
        );
      });
    }, 10_000);
    return () => clearInterval(t);
  }, [client]);

  // Auto-pick the first session as active once we have one. Also recovers
  // from a stale persisted id whose session no longer exists.
  useEffect(() => {
    if (sessions.length === 0) return;
    if (activeSessionId && sessions.some((s) => s.id === activeSessionId)) return;
    setActiveSessionId(sessions[0].id);
  }, [sessions, activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const rootSessionId = useMemo(
    () => (activeSession ? rootIdOf(activeSession, sessions) : null),
    [activeSession, sessions],
  );
  const rootSession = useMemo(
    () => sessions.find((s) => s.id === rootSessionId) ?? null,
    [sessions, rootSessionId],
  );

  const treeSessions = useMemo(() => {
    if (!rootSessionId) return [];
    return sessions.filter((s) => s.id === rootSessionId || s.parentSessionId === rootSessionId);
  }, [sessions, rootSessionId]);

  // Load chat history + tasks + subagent tree when the active session changes.
  // Depend on the session ID (a stable string) — not on the session record —
  // so a session.updated event (e.g. token-count bump after a message) doesn't
  // re-clear the transcript, which would briefly empty it and yank the chat
  // scroll position to the top.
  useEffect(() => {
    if (!activeSessionId) {
      setSessionQuestions([]);
      setSessionApprovals([]);
      return;
    }
    setMessages([]);
    setLiveTools([]);
    setStreaming("");
    setAwaitingResponse(false);
    setChatError(null);
    setTasks([]);
    setSessionQuestions([]);
    setSessionApprovals([]);
    let cancelled = false;
    void (async () => {
      const [hist, taskList, toolCallsRes] = await Promise.all([
        tryRequest(
          () => client.request("chat.history", { sessionId: activeSessionId, limit: 200 }),
          { messages: [] as MessageRecord[] },
        ),
        tryRequest(
          () =>
            client
              .request("tasks.list", { sessionId: activeSessionId, includeDeleted: false })
              .then((r) => r.tasks as Task[]),
          [] as Task[],
        ),
        // Hydrate persisted tool-call audit trail so refresh doesn't drop
        // tool activity from providers that ran their own internal loop
        // (claude-cli). Native models' tool_use blocks land in messages
        // and render from there; buildRows dedups via llmToolUseId.
        tryRequest(
          () =>
            client.request("chat.tool_calls", {
              sessionId: activeSessionId,
              limit: 500,
            }),
          { toolCalls: [] as Array<import("@squad/protocol").ToolCallRecord> },
        ),
      ]);
      if (cancelled) return;
      setMessages(hist.messages);
      setTasks(taskList);
      // Flatten persisted tool calls into the live-event timeline. Each
      // record becomes a call event plus (if completed) a result event,
      // keyed by the LLM-side tool_use id so buildRows' seenToolUseIds
      // dedup catches anything already in a persisted assistant message.
      const hydrated: LiveToolEvent[] = [];
      for (const tc of toolCallsRes.toolCalls) {
        const id = tc.llmToolUseId ?? tc.id;
        hydrated.push({
          kind: "call",
          toolCallId: id,
          name: tc.name,
          input: tc.input,
          at: tc.createdAt,
        });
        if (tc.status === "completed" || tc.status === "failed") {
          hydrated.push({
            kind: "result",
            toolCallId: id,
            result: tc.result,
            isError: tc.isError,
            at: tc.createdAt,
          });
        }
      }
      setLiveTools(hydrated);
    })();
    void refreshSessionQuestions(activeSessionId);
    void refreshSessionApprovals(activeSessionId);
    if (rootSessionId) void refreshTreeFor(rootSessionId);
    return () => {
      cancelled = true;
    };
  }, [
    client,
    activeSessionId,
    rootSessionId,
    refreshTreeFor,
    refreshSessionQuestions,
    refreshSessionApprovals,
  ]);

  // Subscribe to all event streams once.
  useEffect(() => {
    const wantedTopics = [
      "session.*",
      "chat.*/*",
      "tasks.*/*",
      "questions.*/*",
      "approvals.*/*",
      "approvals.*",
      "subagents.*/*",
      "plugins.*",
      "plugins.*/*",
      "channels.*",
      "routines.*/*",
      "routines.*",
      "peers.*",
      "logs.entry",
    ];
    const fresh = wantedTopics.filter((t) => !subscribedRef.current.has(t));
    if (fresh.length > 0) {
      void client.subscribe(fresh as [string, ...string[]]).catch(() => {});
      for (const t of fresh) subscribedRef.current.add(t);
    }
    const off = client.onEvent((topic, data) => {
      const item = activityFromEvent(topic, data);
      if (item) {
        setActivity((cur) => [item, ...cur].slice(0, ACTIVITY_LIMIT));
      }

      if (topic === "session.created") {
        const next = (data as { session: SessionRecord }).session;
        // Append at the front so newly-created sessions land at the top of
        // the list without forcing a refetch.
        setSessions((cur) => (cur.some((s) => s.id === next.id) ? cur : [next, ...cur]));
      } else if (topic === "session.updated") {
        const next = (data as { session: SessionRecord }).session;
        setSessions((cur) => {
          const idx = cur.findIndex((s) => s.id === next.id);
          if (idx === -1) return [next, ...cur];
          const copy = cur.slice();
          copy[idx] = next;
          return copy;
        });
      } else if (topic.startsWith("chat.text_delta/")) {
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          setStreaming((s) => s + (data as { delta: string }).delta);
          setAwaitingResponse(false);
        }
      } else if (topic.startsWith("chat.user_message/")) {
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          setMessages((m) => [...m, (data as { message: MessageRecord }).message]);
          // A new user message means whatever errored before is no longer
          // the most recent thing — clear the banner.
          setChatError(null);
          setAwaitingResponse(true);
        }
      } else if (topic.startsWith("chat.assistant_message/")) {
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          setMessages((m) => [...m, (data as { message: MessageRecord }).message]);
          setStreaming("");
          setAwaitingResponse(false);
        }
      } else if (topic.startsWith("chat.tool_call/")) {
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          const d = data as { toolCallId: string; name: string; input: unknown };
          setLiveTools((cur) => [
            ...cur,
            {
              kind: "call",
              toolCallId: d.toolCallId,
              name: d.name,
              input: d.input,
              at: new Date().toISOString(),
            },
          ]);
          // The agent is mid-tool — text streaming is paused, so clear it
          // (the next text_delta will start a fresh chunk after the result).
          setStreaming("");
          setAwaitingResponse(false);
        }
      } else if (topic.startsWith("chat.tool_result/")) {
        // Between a tool finishing and the next text/tool_use, the agent is
        // thinking again — re-arm the indicator. We also append the result so
        // the transcript can pair it with the call (CLI-style ⏺/⎿ output).
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          const d = data as {
            toolCallId: string;
            result: unknown;
            isError?: boolean;
          };
          setLiveTools((cur) => [
            ...cur,
            {
              kind: "result",
              toolCallId: d.toolCallId,
              result: d.result,
              isError: d.isError ?? false,
              at: new Date().toISOString(),
            },
          ]);
          setAwaitingResponse(true);
        }
      } else if (topic.startsWith("chat.error/")) {
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          const d = data as { message?: string };
          setChatError({ message: d.message ?? "chat error", at: new Date().toISOString() });
          setStreaming("");
          setAwaitingResponse(false);
        }
      } else if (topic.startsWith("tasks.")) {
        if (activeSession) {
          void client
            .request("tasks.list", { sessionId: activeSession.id, includeDeleted: false })
            .then((r) => setTasks(r.tasks as Task[]))
            .catch(() => {});
        }
      } else if (topic.startsWith("questions.")) {
        void refreshPending();
        // Topic format: `questions.<event>/<sessionId>`. Only re-pull the
        // active session's full list when the event is for it — keeps the
        // chat transcript in sync (answered/cancelled questions stay
        // visible after the status change).
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          void refreshSessionQuestions(activeSessionId);
        }
      } else if (topic.startsWith("approvals.")) {
        void refreshPending();
        // Topic format: `approvals.<event>/<sessionId>` (rule events have no
        // session and are skipped here). Re-pull the active session's full
        // list when the event matches so decided approvals stay visible
        // with their final status.
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
          void refreshSessionApprovals(activeSessionId);
        }
      } else if (topic.startsWith("subagents.spawned")) {
        void refreshSessions();
        if (rootSessionId) void refreshTreeFor(rootSessionId);
      } else if (topic.startsWith("subagents.completed") || topic.startsWith("subagents.failed")) {
        if (rootSessionId) void refreshTreeFor(rootSessionId);
      } else if (topic.startsWith("plugins.")) {
        void refreshPlugins();
      } else if (topic.startsWith("channels.")) {
        void refreshChannels();
      } else if (topic === "peers.changed") {
        const next = (data as { peers: PeerRecord[] }).peers;
        if (Array.isArray(next)) setPeers(next);
      } else if (topic.startsWith("routines.")) {
        void refreshRoutines();
      } else if (topic === "pair.requested" || topic === "pair.approved" || topic === "pair.cancelled") {
        void refreshPairings();
      } else if (topic === "logs.entry") {
        // Bump the unread badge when a fresh error/fatal lands. The Logs
        // view clears the counter on mount via markLogsRead().
        const entry = (data as { entry: LogEntry }).entry;
        if (entry.level === "error" || entry.level === "fatal") {
          setUnreadLogErrors((n) => n + 1);
        }
      }
    });
    return off;
  }, [
    client,
    activeSessionId,
    activeSession,
    rootSessionId,
    refreshPending,
    refreshSessionQuestions,
    refreshSessionApprovals,
    refreshSessions,
    refreshPlugins,
    refreshTreeFor,
    refreshChannels,
    refreshRoutines,
    refreshPairings,
  ]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const sendChat = useCallback(
    async (text: string) => {
      if (!activeSession || !text.trim()) return;
      try {
        setChatError(null);
        setAwaitingResponse(true);
        await client.request("chat.send", { sessionId: activeSession.id, content: text });
      } catch (err) {
        // Surface the rejection in the chat banner so the user sees that
        // the gateway refused the send (no provider, bad model, etc.).
        setChatError({
          message: (err as Error).message ?? "chat.send failed",
          at: new Date().toISOString(),
        });
        setAwaitingResponse(false);
        throw err;
      }
    },
    [client, activeSession],
  );

  const cancelChat = useCallback(async (): Promise<boolean> => {
    if (!activeSession) return false;
    const r = await client.request("chat.cancel", { sessionId: activeSession.id });
    return r.cancelled;
  }, [client, activeSession]);

  const startSession = useCallback(
    async (opts: { title?: string; model?: string; fallbacks?: string[] }) => {
      const { session: s } = await client.request("session.start", {
        title: opts.title,
        model: opts.model,
        fallbacks: opts.fallbacks,
      });
      setActiveSessionId(s.id);
      await refreshSessions();
    },
    [client, refreshSessions],
  );

  const answerQuestion = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      const q =
        sessionQuestions.find((x) => x.id === questionId) ??
        pendingQuestions.find((x) => x.id === questionId);
      if (!q) return;
      await client.request("questions.answer", {
        sessionId: q.sessionId,
        questionId,
        answers,
      });
    },
    [client, sessionQuestions, pendingQuestions],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "deny", reason?: string) => {
      await client.request("approvals.decide", { approvalId, decision, reason });
    },
    [client],
  );

  const dismissQuestion = useCallback(
    async (questionId: string) => {
      const q =
        sessionQuestions.find((x) => x.id === questionId) ??
        pendingQuestions.find((x) => x.id === questionId);
      if (!q) return;
      await client.request("questions.cancel", {
        sessionId: q.sessionId,
        questionId,
        reason: "dismissed by user",
      });
    },
    [client, sessionQuestions, pendingQuestions],
  );

  const dismissApproval = useCallback(
    async (approvalId: string) => {
      await client.request("approvals.decide", {
        approvalId,
        decision: "deny",
        reason: "dismissed by user",
      });
    },
    [client],
  );

  const allowApprovalPath = useCallback(
    async (approvalId: string, scope: "exact" | "tool" = "exact") => {
      await client.request("approvals.allow_path", { approvalId, scope });
    },
    [client],
  );

  const createTask = useCallback(
    async (subject: string, description: string = "") => {
      if (!activeSession) return;
      await client.request("tasks.create", {
        sessionId: activeSession.id,
        subject,
        description,
      });
    },
    [client, activeSession],
  );

  const updateTaskStatus = useCallback(
    async (taskId: string, status: Task["status"]) => {
      if (!activeSession) return;
      await client.request("tasks.update", {
        sessionId: activeSession.id,
        taskId,
        status,
      });
    },
    [client, activeSession],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await client.request("session.rename", { sessionId, title });
      await refreshSessions();
    },
    [client, refreshSessions],
  );

  const setSessionModel = useCallback(
    async (sessionId: string, model: string, fallbacks?: string[]) => {
      await client.request("session.setModel", {
        sessionId,
        model,
        ...(fallbacks !== undefined ? { fallbacks } : {}),
      });
      await refreshSessions();
    },
    [client, refreshSessions],
  );

  const setSessionTitleModel = useCallback(
    async (sessionId: string, titleModel: string | null) => {
      await client.request("session.setTitleModel", { sessionId, titleModel });
    },
    [client],
  );

  const reloadPlugin = useCallback(
    async (id: string) => {
      await client.request("plugins.reload", { id });
    },
    [client],
  );

  const cancelPairing = useCallback(
    async (code: string) => {
      await client.request("admin.pair.cancel", { code });
      await refreshPairings();
    },
    [client, refreshPairings],
  );

  const createRoutine = useCallback(
    async (input: CreateRoutineInput) => {
      const enabled = input.enabled ?? true;
      const delivery = input.delivery ?? { kind: "dashboard" as const };
      if ("schedule" in input) {
        await client.request("routines.create", {
          name: input.name,
          enabled,
          schedule: input.schedule,
          payload: input.payload,
          session: input.session ?? { kind: "new" as const },
          execution: input.execution ?? {},
          delivery,
        });
      } else {
        await client.request("routines.create", {
          name: input.name,
          enabled,
          cron: input.cron,
          prompt: input.prompt,
          ...(input.model !== undefined ? { model: input.model } : {}),
          delivery,
        });
      }
      await refreshRoutines();
    },
    [client, refreshRoutines],
  );

  const updateRoutine = useCallback(
    async (id: string, patch: UpdateRoutinePatch) => {
      await client.request("routines.update", {
        id,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
        ...(patch.session !== undefined ? { session: patch.session } : {}),
        ...(patch.execution !== undefined ? { execution: patch.execution } : {}),
        ...(patch.delivery !== undefined ? { delivery: patch.delivery } : {}),
        // Legacy passthroughs.
        ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
      });
      await refreshRoutines();
    },
    [client, refreshRoutines],
  );

  const fetchRoutineRuns = useCallback(
    async (
      id: string,
      opts: { limit?: number; status?: "ok" | "error" | "skipped" } = {},
    ): Promise<RoutineRunLog[]> => {
      const r = await client.request("routines.runs", {
        jobId: id,
        limit: opts.limit ?? 20,
        ...(opts.status ? { status: opts.status } : {}),
      });
      return r.runs;
    },
    [client],
  );

  const deleteRoutine = useCallback(
    async (id: string) => {
      await client.request("routines.delete", { id });
      await refreshRoutines();
    },
    [client, refreshRoutines],
  );

  const runRoutine = useCallback(
    async (id: string) => {
      const r = await client.request("routines.run_now", { id });
      await refreshRoutines();
      return r;
    },
    [client, refreshRoutines],
  );

  const value: GatewayState = {
    client,
    connectionStatus,
    squad,
    branding,
    peers,
    config,
    fullConfig,
    models,
    plugins,
    channels,
    sessions,
    pendingQuestions,
    sessionQuestions,
    pendingApprovals,
    sessionApprovals,
    routines,
    pairings,
    activity,
    chatError,
    clearChatError: () => setChatError(null),
    activeSessionId,
    activeSession,
    rootSession,
    treeSessions,
    messages,
    liveTools,
    tasks,
    streaming,
    awaitingResponse,
    subagentTree,
    setActiveSessionId,
    refreshSessions: async () => {
      await refreshSessions();
    },
    refreshRoutines,
    refreshPairings,
    sendChat,
    cancelChat,
    startSession,
    renameSession,
    setSessionModel,
    setSessionTitleModel,
    answerQuestion,
    dismissQuestion,
    decideApproval,
    dismissApproval,
    allowApprovalPath,
    createTask,
    updateTaskStatus,
    reloadPlugin,
    cancelPairing,
    refreshFullConfig,
    setConfigPath,
    unsetConfigPath,
    createRoutine,
    updateRoutine,
    deleteRoutine,
    runRoutine,
    fetchRoutineRuns,
    unreadLogErrors,
    markLogsRead: () => setUnreadLogErrors(0),
  };

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}
