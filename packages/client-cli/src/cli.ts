#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ProtocolClient } from "./protocol-client.js";
import * as render from "./render.js";
import type { Task, QuestionRecord } from "@squad/protocol";

interface Env {
  url: string;
  token: string;
}

function readEnv(): Env {
  const url = process.env.SQUAD_URL ?? "ws://127.0.0.1:8080/ws";
  const token = process.env.SQUAD_TOKEN;
  if (!token) {
    render.renderError("SQUAD_TOKEN is required");
    process.exit(1);
  }
  return { url, token };
}

async function main(): Promise<void> {
  const env = readEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();

  const { session } = await client.request("session.start", { title: "cli" });
  await client.subscribe([
    `chat.*/${session.id}`,
    `tasks.*/${session.id}`,
    `questions.*/${session.id}`,
  ]);

  let pendingQuestion: QuestionRecord | null = null;

  client.onEvent((topic, data) => {
    if (topic.startsWith("chat.text_delta/")) {
      render.renderDelta((data as { delta: string }).delta);
    } else if (topic.startsWith("chat.assistant_message/")) {
      render.renderNewline();
    } else if (topic.startsWith("chat.tool_call/")) {
      const d = data as { name: string; input: unknown };
      render.renderToolCall(d.name, d.input);
    } else if (topic.startsWith("tasks.")) {
      void refreshTasks(client, session.id);
    } else if (topic.startsWith("questions.asked/")) {
      pendingQuestion = (data as { question: QuestionRecord }).question;
      process.stdout.write(render.renderAskPrompt(pendingQuestion));
    } else if (topic.startsWith("questions.answered/")) {
      pendingQuestion = null;
    }
  });

  const rl = createInterface({ input: stdin, output: stdout });

  render.renderNewline();
  process.stdout.write(`Connected. Session ${session.id}.\n`);
  process.stdout.write(`Type a message and press enter. Ctrl+C to exit.\n`);

  const loop = async (): Promise<void> => {
    while (true) {
      render.renderUserLine(">");
      const line = await rl.question("");
      if (!line.trim()) continue;

      if (pendingQuestion) {
        await handleAnswer(client, pendingQuestion, line);
        pendingQuestion = null;
        continue;
      }

      try {
        await client.request("chat.send", {
          sessionId: session.id,
          content: line,
        });
      } catch (err) {
        render.renderError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  await loop();
  rl.close();
  client.close();
}

async function handleAnswer(
  client: ProtocolClient,
  question: QuestionRecord,
  input: string,
): Promise<void> {
  const q = question.input.questions[0]!;
  let chosen: string | null = null;
  const lower = input.trim().toLowerCase();
  const n = Number.parseInt(lower, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= q.options.length) {
    chosen = q.options[n - 1]!.label;
  } else if (lower === "o") {
    chosen = input.slice(input.indexOf(" ") + 1).trim() || "Other";
  } else {
    chosen = input.trim();
  }
  await client.request("questions.answer", {
    sessionId: question.sessionId,
    questionId: question.id,
    answers: { [q.question]: chosen },
  });
}

async function refreshTasks(client: ProtocolClient, sessionId: string): Promise<void> {
  try {
    const { tasks } = await client.request("tasks.list", { sessionId, includeDeleted: false });
    render.renderTaskList(tasks as Task[]);
  } catch {
    // Best-effort refresh.
  }
}

main().catch((err) => {
  render.renderError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
