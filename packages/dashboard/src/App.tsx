import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProtocolClient } from "./protocol-client.js";
import type { Task, QuestionRecord, SessionRecord, MessageRecord } from "@squad/protocol";
import { Chat } from "./views/Chat.js";
import { Tasks } from "./views/Tasks.js";
import { Sessions } from "./views/Sessions.js";
import "./styles.css";

type View = "chat" | "tasks" | "sessions";

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

      const { sessions: list } = await client.request("session.list", {
        parentSessionId: null,
        limit: 50,
      });
      setSessions(list);

      // Start a session if none exists.
      const s = list[0] ?? (await client.request("session.start", { title: "Dashboard" })).session;
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
