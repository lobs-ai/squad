import { useState } from "react";
import type { BrowserProtocolClient } from "../protocol-client.js";
import type { MessageRecord, QuestionRecord, SessionRecord, Task } from "@squad/protocol";

interface Props {
  client: BrowserProtocolClient;
  session: SessionRecord;
  messages: MessageRecord[];
  streamingText: string;
  pendingQuestion: QuestionRecord | null;
  tasks: Task[];
}

export function Chat({
  client,
  session,
  messages,
  streamingText,
  pendingQuestion,
  tasks,
}: Props): JSX.Element {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const send = async (): Promise<void> => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await client.request("chat.send", { sessionId: session.id, content: input });
      setInput("");
    } finally {
      setSending(false);
    }
  };

  const answer = async (questionId: string, questionText: string, label: string): Promise<void> => {
    await client.request("questions.answer", {
      sessionId: session.id,
      questionId,
      answers: { [questionText]: label },
    });
  };

  const activeTasks = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "pending",
  ).slice(0, 5);

  return (
    <div className="chat">
      <div className="transcript">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="body">
              {m.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b, i) => (
                  <div key={i}>{b.text}</div>
                ))}
            </div>
          </div>
        ))}
        {streamingText && (
          <div className="msg assistant streaming">
            <div className="role">assistant</div>
            <div className="body">{streamingText}</div>
          </div>
        )}
        {pendingQuestion && (
          <AskCard
            question={pendingQuestion}
            onAnswer={(label) =>
              answer(
                pendingQuestion.id,
                pendingQuestion.input.questions[0]!.question,
                label,
              )
            }
          />
        )}
      </div>

      {activeTasks.length > 0 && (
        <aside className="tasks-sidebar">
          <h3>Active tasks</h3>
          {activeTasks.map((t) => (
            <div key={t.id} className={`task ${t.status}`}>
              <span className="subject">{t.subject}</span>
              {t.owner && <span className="owner">{t.owner}</span>}
            </div>
          ))}
        </aside>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={sending}
        />
        <button type="submit" disabled={sending}>Send</button>
      </form>
    </div>
  );
}

function AskCard({
  question,
  onAnswer,
}: {
  question: QuestionRecord;
  onAnswer: (label: string) => Promise<void>;
}): JSX.Element {
  const q = question.input.questions[0]!;
  return (
    <div className="ask-card">
      <div className="header">{q.header}</div>
      <div className="question">{q.question}</div>
      <div className="options">
        {q.options.map((opt) => (
          <button key={opt.label} onClick={() => void onAnswer(opt.label)}>
            <div className="label">{opt.label}</div>
            <div className="desc">{opt.description}</div>
            {opt.preview && <pre>{opt.preview}</pre>}
          </button>
        ))}
      </div>
    </div>
  );
}
