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
import { BrowserProtocolClient } from "../protocol-client.js";
import type {
  ApprovalRecord,
  MessageRecord,
  PairingView,
  PeerRecord,
  PluginRecord,
  QuestionRecord,
  RoutineRecord,
  SessionRecord,
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
  squad: SquadIdentity | null;
  peers: PeerRecord[];
  config: AdminConfig | null;
  fullConfig: FullConfigState | null;
  models: ModelOption[];
  plugins: PluginRecord[];
  channels: ChannelRecord[];
  sessions: SessionRecord[];
  pendingQuestions: QuestionRecord[];
  pendingApprovals: ApprovalRecord[];
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
  startSession: (opts: { title?: string; model?: string; fallbacks?: string[] }) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setSessionModel: (sessionId: string, model: string, fallbacks?: string[]) => Promise<void>;
  answerQuestion: (questionId: string, label: string) => Promise<void>;
  decideApproval: (approvalId: string, decision: "approve" | "deny", reason?: string) => Promise<void>;
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
  createRoutine: (input: {
    name: string;
    cron: string;
    prompt: string;
    model?: string;
    delivery?: RoutineRecord["delivery"];
    enabled?: boolean;
  }) => Promise<void>;
  updateRoutine: (id: string, patch: Partial<RoutineRecord>) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  runRoutine: (id: string) => Promise<{ sessionId: string }>;
}

const GatewayContext = createContext<GatewayState | null>(null);

export function useGateway(): GatewayState {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway() must be used inside <GatewayProvider/>");
  return ctx;
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
  const [peers, setPeers] = useState<PeerRecord[]>([]);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [fullConfig, setFullConfig] = useState<FullConfigState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRecord[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRecord[]>([]);
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [pairings, setPairings] = useState<PairingView[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [streaming, setStreaming] = useState<string>("");
  const [awaitingResponse, setAwaitingResponse] = useState<boolean>(false);
  const [chatError, setChatError] = useState<{ message: string; at: string } | null>(null);
  const [subagentTree, setSubagentTree] = useState<SubagentTreeNode | null>(null);
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
    },
    [client],
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

  // Auto-pick the first session as active once we have one.
  useEffect(() => {
    if (!activeSessionId && sessions[0]) setActiveSessionId(sessions[0].id);
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
  useEffect(() => {
    if (!activeSession) return;
    setMessages([]);
    setStreaming("");
    setAwaitingResponse(false);
    setChatError(null);
    setTasks([]);
    let cancelled = false;
    void (async () => {
      const [hist, taskList] = await Promise.all([
        tryRequest(
          () => client.request("chat.history", { sessionId: activeSession.id, limit: 200 }),
          { messages: [] as MessageRecord[] },
        ),
        tryRequest(
          () =>
            client
              .request("tasks.list", { sessionId: activeSession.id, includeDeleted: false })
              .then((r) => r.tasks as Task[]),
          [] as Task[],
        ),
      ]);
      if (cancelled) return;
      setMessages(hist.messages);
      setTasks(taskList);
    })();
    if (rootSessionId) void refreshTreeFor(rootSessionId);
    return () => {
      cancelled = true;
    };
  }, [client, activeSession, rootSessionId, refreshTreeFor]);

  // Subscribe to all event streams once.
  useEffect(() => {
    const wantedTopics = [
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

      if (topic.startsWith("chat.text_delta/")) {
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
      } else if (topic.startsWith("chat.tool_result/")) {
        // Between a tool finishing and the next text/tool_use, the agent is
        // thinking again — re-arm the indicator. The dashboard doesn't render
        // tool calls live (they appear via the final assistant_message), so
        // without this the UI looks idle for the whole tool turn.
        const tSess = topic.split("/")[1];
        if (activeSessionId && tSess === activeSessionId) {
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
      } else if (topic.startsWith("approvals.")) {
        void refreshPending();
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
      }
    });
    return off;
  }, [
    client,
    activeSessionId,
    activeSession,
    rootSessionId,
    refreshPending,
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
    async (questionId: string, label: string) => {
      const q = pendingQuestions.find((x) => x.id === questionId);
      if (!q) return;
      const first = q.input.questions[0]!;
      await client.request("questions.answer", {
        sessionId: q.sessionId,
        questionId,
        answers: { [first.question]: label },
      });
    },
    [client, pendingQuestions],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approve" | "deny", reason?: string) => {
      await client.request("approvals.decide", { approvalId, decision, reason });
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
    async (input: {
      name: string;
      cron: string;
      prompt: string;
      model?: string;
      delivery?: RoutineRecord["delivery"];
      enabled?: boolean;
    }) => {
      await client.request("routines.create", {
        name: input.name,
        cron: input.cron,
        prompt: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        delivery: input.delivery ?? { kind: "dashboard" },
        enabled: input.enabled ?? true,
      });
      await refreshRoutines();
    },
    [client, refreshRoutines],
  );

  const updateRoutine = useCallback(
    async (id: string, patch: Partial<RoutineRecord>) => {
      await client.request("routines.update", {
        id,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.delivery !== undefined ? { delivery: patch.delivery } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      await refreshRoutines();
    },
    [client, refreshRoutines],
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
    squad,
    peers,
    config,
    fullConfig,
    models,
    plugins,
    channels,
    sessions,
    pendingQuestions,
    pendingApprovals,
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
    startSession,
    renameSession,
    setSessionModel,
    answerQuestion,
    decideApproval,
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
  };

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}
