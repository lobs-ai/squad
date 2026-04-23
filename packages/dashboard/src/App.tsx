import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProtocolClient } from "./protocol-client.js";
import type { Task, QuestionRecord, SessionRecord, MessageRecord } from "@squad/protocol";
import { Chat } from "./views/Chat.js";
import { Tasks } from "./views/Tasks.js";
import { Sessions } from "./views/Sessions.js";
import "./styles.css";

type View = "chat" | "tasks" | "sessions";

interface ModelOption {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  notes?: string;
}

export function App(): JSX.Element {
  const [tokenInput, setTokenInput] = useState<string>(
    () => localStorage.getItem("squad-token") ?? "",
  );
  const [connected, setConnected] = useState<boolean>(false);
  const [view, setView] = useState<View>("chat");
  const clientRef = useRef<BrowserProtocolClient | null>(null);

  const [session, setSession] = useState<SessionRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [streamingText, setStreamingText] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRecord | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);

  // Model-picker state.
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [defaultPrimary, setDefaultPrimary] = useState<string>("");
  const [defaultFallbacks, setDefaultFallbacks] = useState<string[]>([]);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "127.0.0.1:8080";
    return `${proto}//${host}/ws`;
  }, []);

  const connect = useCallback(
    async (token: string) => {
      localStorage.setItem("squad-token", token);
      const client = new BrowserProtocolClient(wsUrl, token);
      await client.connect();
      clientRef.current = client;
      setConnected(true);

      // Pull gateway config + model catalog. Both are cheap and let the UI
      // show the user what chain is in play before they start a session.
      const [cfg, models] = await Promise.all([
        client.request("admin.config", {}),
        client.request("admin.models", {}),
      ]);
      setAvailableModels(models.models);
      setDefaultPrimary(cfg.primary.model);
      setDefaultFallbacks(cfg.fallbacks.map((f) => f.model));

      const { sessions: list } = await client.request("session.list", {
        parentSessionId: null,
        limit: 50,
      });
      setSessions(list);

      // Start a session if none exists — inheriting the gateway's configured
      // chain. Users pick a different model via the "New session" button.
      const s =
        list[0] ??
        (
          await client.request("session.start", { title: "Dashboard" })
        ).session;
      setSession(s);

      await client.subscribe([
        `chat.*/${s.id}`,
        `tasks.*/${s.id}`,
        `questions.*/${s.id}`,
      ]);

      const { tasks: currentTasks } = await client.request("tasks.list", {
        sessionId: s.id,
        includeDeleted: false,
      });
      setTasks(currentTasks as Task[]);

      const { messages: currentMessages } = await client.request("chat.history", {
        sessionId: s.id,
        limit: 100,
      });
      setMessages(currentMessages);

      client.onEvent((topic, data) => {
        if (topic.startsWith("chat.text_delta/")) {
          setStreamingText((t) => t + (data as { delta: string }).delta);
        } else if (topic.startsWith("chat.user_message/")) {
          setMessages((m) => [...m, (data as { message: MessageRecord }).message]);
        } else if (topic.startsWith("chat.assistant_message/")) {
          setMessages((m) => [...m, (data as { message: MessageRecord }).message]);
          setStreamingText("");
        } else if (topic.startsWith("tasks.")) {
          // Any task mutation — refetch.
          void client.request("tasks.list", { sessionId: s.id, includeDeleted: false }).then((r) => {
            setTasks(r.tasks as Task[]);
          });
        } else if (topic.startsWith("questions.asked/")) {
          setPendingQuestion((data as { question: QuestionRecord }).question);
        } else if (topic.startsWith("questions.answered/")) {
          setPendingQuestion(null);
        }
      });
    },
    [wsUrl],
  );

  const startSession = useCallback(
    async (primary: string, fallbacks: string[], title: string) => {
      const client = clientRef.current;
      if (!client) return;
      const { session: s } = await client.request("session.start", {
        title: title || "Dashboard",
        model: primary,
        fallbacks,
      });
      setSession(s);
      setMessages([]);
      setTasks([]);
      setStreamingText("");
      setPendingQuestion(null);
      const { sessions: list } = await client.request("session.list", {
        parentSessionId: null,
        limit: 50,
      });
      setSessions(list);
      await client.subscribe([
        `chat.*/${s.id}`,
        `tasks.*/${s.id}`,
        `questions.*/${s.id}`,
      ]);
    },
    [],
  );

  useEffect(() => {
    return () => {
      clientRef.current?.close();
    };
  }, []);

  if (!connected) {
    return (
      <div className="gate">
        <h1>Squad</h1>
        <p>Enter your gateway token.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void connect(tokenInput);
          }}
        >
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="token"
          />
          <button type="submit">Connect</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <nav>
        <button className={view === "chat" ? "on" : ""} onClick={() => setView("chat")}>Chat</button>
        <button className={view === "tasks" ? "on" : ""} onClick={() => setView("tasks")}>Tasks</button>
        <button className={view === "sessions" ? "on" : ""} onClick={() => setView("sessions")}>Sessions</button>
        {availableModels.length > 0 && (
          <NewSessionPanel
            models={availableModels}
            defaultPrimary={defaultPrimary}
            defaultFallbacks={defaultFallbacks}
            onStart={(p, f, t) => void startSession(p, f, t)}
          />
        )}
      </nav>
      <main>
        {view === "chat" && session && clientRef.current && (
          <Chat
            client={clientRef.current}
            session={session}
            messages={messages}
            streamingText={streamingText}
            pendingQuestion={pendingQuestion}
            tasks={tasks}
          />
        )}
        {view === "tasks" && <Tasks tasks={tasks} />}
        {view === "sessions" && <Sessions sessions={sessions} activeId={session?.id} />}
      </main>
    </div>
  );
}

// ── NewSessionPanel ──────────────────────────────────────────────────────────
//
// A compact form in the side-nav: primary model + zero-or-more fallbacks +
// optional title. Renders nothing while the gateway has no providers wired
// up (in which case we'd have no catalog to show). Fallbacks are sticky for
// the life of the session — see createModelChain in packages/llm.

interface NewSessionPanelProps {
  models: ModelOption[];
  defaultPrimary: string;
  defaultFallbacks: string[];
  onStart: (primary: string, fallbacks: string[], title: string) => void;
}

function NewSessionPanel({
  models,
  defaultPrimary,
  defaultFallbacks,
  onStart,
}: NewSessionPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [primary, setPrimary] = useState(defaultPrimary);
  const [fallbacks, setFallbacks] = useState<string[]>(defaultFallbacks);
  const [title, setTitle] = useState("");

  useEffect(() => { setPrimary(defaultPrimary); }, [defaultPrimary]);
  useEffect(() => { setFallbacks(defaultFallbacks); }, [defaultFallbacks]);

  if (!open) {
    return (
      <button className="new-session-toggle" onClick={() => setOpen(true)}>
        + New session
      </button>
    );
  }

  // Models not already in the primary or fallbacks slot are eligible to be
  // added to the chain.
  const available = models.filter(
    (m) => m.id !== primary && !fallbacks.includes(m.id),
  );

  return (
    <div className="new-session-panel">
      <div className="label">New session</div>
      <input
        type="text"
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <div className="field-label">Primary</div>
      <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.displayName}</option>
        ))}
        {!models.find((m) => m.id === primary) && primary && (
          <option value={primary}>{primary} (custom)</option>
        )}
      </select>

      <div className="field-label">Fallbacks (tried in order, sticky)</div>
      {fallbacks.length === 0 && <div className="dim">None — primary only.</div>}
      <ul className="fallback-chain">
        {fallbacks.map((id, i) => {
          const info = models.find((m) => m.id === id);
          return (
            <li key={id}>
              <span>{i + 1}. {info?.displayName ?? id}</span>
              <button onClick={() => setFallbacks(fallbacks.filter((f) => f !== id))}>
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {available.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) setFallbacks([...fallbacks, e.target.value]);
          }}
        >
          <option value="">+ add fallback…</option>
          {available.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}</option>
          ))}
        </select>
      )}

      <div className="actions">
        <button
          className="primary"
          onClick={() => {
            onStart(primary, fallbacks, title);
            setOpen(false);
          }}
        >
          Start
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
