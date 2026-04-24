import { ProtocolClient } from "../protocol-client.js";
import * as render from "../render.js";
import { resolveEnv } from "../env.js";
import { getLastSessionId } from "../session-store.js";
import type { Task } from "@squad/protocol";

export async function listTasks(sessionArg?: string): Promise<void> {
  const sessionId = sessionArg ?? getLastSessionId();
  if (!sessionId) {
    throw new Error("no session. Pass --session <id> or run `squad chat` first.");
  }
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    const { tasks } = await client.request("tasks.list", {
      sessionId,
      includeDeleted: false,
    });
    render.renderTaskList(tasks as Task[]);
    if (!tasks.length) process.stdout.write("(no tasks)\n");
  } finally {
    client.close();
  }
}
