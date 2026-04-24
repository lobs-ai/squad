import { ProtocolClient } from "../protocol-client.js";
import { resolveEnv } from "../env.js";
import { getLastSessionId } from "../session-store.js";

export async function answerQuestion(
  questionId: string,
  answer: string,
  sessionArg?: string,
): Promise<void> {
  const sessionId = sessionArg ?? getLastSessionId();
  if (!sessionId) throw new Error("no session. Pass --session <id>.");
  if (!questionId) throw new Error("usage: squad ask <questionId> <answer>");

  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    // We don't know the question body shape here, so answer against a generic
    // single-key payload. The gateway validates and errors out if mismatched.
    await client.request("questions.answer", {
      sessionId,
      questionId,
      answers: { answer },
    });
    process.stdout.write("✓ answered\n");
  } finally {
    client.close();
  }
}

export async function listQuestions(sessionArg?: string): Promise<void> {
  const sessionId = sessionArg ?? getLastSessionId();
  if (!sessionId) throw new Error("no session. Pass --session <id>.");
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    const { questions } = await client.request("questions.list", { sessionId });
    if (!questions.length) {
      process.stdout.write("(no open questions)\n");
      return;
    }
    for (const q of questions) {
      const first = q.input.questions[0]!;
      process.stdout.write(`${q.id}  ${first.question}\n`);
      for (const [i, opt] of first.options.entries()) {
        process.stdout.write(`   ${i + 1}. ${opt.label}\n`);
      }
    }
  } finally {
    client.close();
  }
}
