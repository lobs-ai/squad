import { ProtocolClient } from "../protocol-client.js";
import * as render from "../render.js";
import { resolveEnv } from "../env.js";
import { getLastSessionId, setLastSessionId, clearLastSessionId } from "../session-store.js";

/**
 * Resolve the session id to use: explicit > stored > fresh. If the stored id
 * doesn't exist on the server (db wiped, gateway rebuilt, etc), fall back to
 * a fresh session instead of failing.
 */
async function resolveSession(
  client: ProtocolClient,
  opts: { sessionId?: string; newSession?: boolean },
): Promise<string> {
  if (opts.sessionId) return opts.sessionId;
  if (!opts.newSession) {
    const cached = getLastSessionId();
    if (cached) {
      try {
        await client.request("session.resume", { sessionId: cached });
        return cached;
      } catch {
        clearLastSessionId();
      }
    }
  }
  // Leave title undefined so the gateway auto-titler names the session
  // from the first user message instead of a generic "cli".
  const { session } = await client.request("session.start", {});
  return session.id;
}

/**
 * One-shot: send a message, stream the reply to stdout, exit when the
 * assistant turn ends. Uses the last session if one exists; otherwise starts
 * a fresh one.
 */
export async function runChat(
  message: string,
  opts: { sessionId?: string; newSession?: boolean } = {},
): Promise<void> {
  if (!message) throw new Error("usage: squad chat <message>");
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();

  const sessionId = await resolveSession(client, opts);
  setLastSessionId(sessionId);

  await client.subscribe([`chat.*/${sessionId}`]);

  let streamedAny = false;
  const done = new Promise<void>((resolve) => {
    client.onEvent((topic, data) => {
      if (topic.startsWith("chat.text_delta/")) {
        streamedAny = true;
        render.renderDelta((data as { delta: string }).delta);
      } else if (topic.startsWith("chat.assistant_message/")) {
        // Non-streaming providers (minimax, some openai-compatible endpoints)
        // skip text_delta and ship the full message in one event. Fall back to
        // rendering it from the message content here.
        if (!streamedAny) {
          const msg = (data as { message: { content: Array<{ type: string; text?: string }> } }).message;
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
          if (text) render.renderDelta(text);
        }
        render.renderNewline();
        resolve();
      } else if (topic.startsWith("chat.tool_call/")) {
        const d = data as { name: string; input: unknown };
        render.renderToolCall(d.name, d.input);
      } else if (topic.startsWith("chat.error/")) {
        render.renderError(`run failed: ${(data as { message: string }).message}`);
        process.exitCode = 1;
        resolve();
      }
    });
  });

  try {
    await client.request("chat.send", { sessionId, content: message });
  } catch (err) {
    render.renderError(err instanceof Error ? err.message : String(err));
    client.close();
    process.exitCode = 1;
    return;
  }

  await done;
  client.close();
}
