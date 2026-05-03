import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolRegistry } from "@squad/tools";
import type { LLMClient } from "@squad/llm";
import type { Authenticator } from "./auth.js";
import type { Broadcast } from "./broadcast.js";
import type { Logger } from "./logger.js";
import type { SessionStore } from "./db/sessions.js";
import type { MessageStore } from "./db/messages.js";
import type { ToolCallStore } from "./db/tool-calls.js";
import type { MemoryService } from "./memory/service.js";
import { runChatTurn } from "./runs.js";
import type { ContentBlock } from "@squad/protocol";

/**
 * OpenAI / Anthropic-compatible HTTP shim. Built in `boot()` and wired into
 * the gateway HTTP server. The handler creates a phantom session, runs one
 * agent turn, and returns the assistant message as either an OpenAI
 * chat-completions response or an Anthropic messages response.
 *
 * Streaming variants (SSE) are routed by `path`. Tool use is intentionally
 * minimal — by default we hand the agent a constrained, read-only tool set
 * because the HTTP caller can't answer ask-user prompts or grant approvals.
 */
export interface HttpApiHandler {
  handle(path: string, req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface HttpApiDeps {
  authenticator: Authenticator;
  sessions: SessionStore;
  messages: MessageStore;
  toolCalls: ToolCallStore;
  broadcast: Broadcast;
  logger: Logger;
  toolRegistry: ToolRegistry;
  defaultModel: string;
  defaultFallbacks: string[];
  workspaceDir: string;
  memory?: MemoryService;
  clientOverride?: LLMClient;
  /** Trace registry — wired by boot. */
  traceRegistry?: import("./traces.js").TraceSessionRegistry;
}

const READONLY_TAGS = new Set(["readonly", "search", "filesystem"]);

export function createHttpApiHandler(deps: HttpApiDeps): HttpApiHandler {
  return {
    async handle(path: string, req: IncomingMessage, res: ServerResponse) {
      const grant = authenticate(req, deps.authenticator);
      if (!grant) {
        sendJson(res, 401, { error: { message: "missing or invalid bearer token" } });
        return;
      }

      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch (err) {
        deps.logger.warn({ err, path, bytes: raw.length }, "http api: invalid JSON body");
        sendJson(res, 400, { error: { message: "invalid JSON body" } });
        return;
      }

      const stream = body.stream === true;
      const model = (body.model as string) ?? deps.defaultModel;
      const messages = extractMessages(path, body);
      if (messages.length === 0) {
        sendJson(res, 400, { error: { message: "missing messages" } });
        return;
      }

      // HTTP requests get a constrained, read-only tool set unless the caller
      // explicitly opts in via `tools: [...]`. They can't answer ask-user or
      // approve writes, so granting full power would be misleading.
      const requestedTools = Array.isArray(body.tools) ? body.tools : null;
      const allowedTools = requestedTools
        ? deps.toolRegistry
            .names()
            .filter((n) => requestedTools.some((rt) => safeName(rt) === n))
        : deps.toolRegistry.filter((def) =>
            (def.tags ?? []).some((t) => READONLY_TAGS.has(t)),
          );

      // Ephemeral session — auto-archived as soon as the turn finishes.
      const session = deps.sessions.create({
        model,
        title: `http-api ${path}`,
      });
      const runId = "run_" + randomUUID().slice(0, 8);
      const userContent: ContentBlock[] = messages.map((m) => ({
        type: "text",
        text: m.content,
      }));
      // Pre-persist user messages (one per role) so transcript matches what
      // the request shipped.
      for (const m of messages) {
        deps.messages.append({
          sessionId: session.id,
          role: m.role,
          content: [{ type: "text", text: m.content }],
        });
      }

      try {
        if (stream) {
          await runStreamed(deps, {
            sessionId: session.id,
            runId,
            path,
            model,
            userContent,
            allowedTools,
            res,
          });
        } else {
          const result = await runChatTurn(
            {
              sessionId: session.id,
              runId,
              userContent: [], // already persisted above
              persistUserMessage: false,
              model,
              fallbacks: deps.defaultFallbacks,
              toolRegistry: deps.toolRegistry,
              cwd: deps.workspaceDir,
              toolsAllow: allowedTools,
              ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
            },
            {
              sessions: deps.sessions,
              messages: deps.messages,
              toolCalls: deps.toolCalls,
              broadcast: deps.broadcast,
              logger: deps.logger,
              ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
              ...(deps.traceRegistry ? { traceRegistry: deps.traceRegistry } : {}),
            },
          );
          const text = extractAssistantText(result.result.output);
          sendJson(
            res,
            200,
            path === "/v1/messages"
              ? renderAnthropic(text, runId, model, result.result.usage)
              : renderOpenAi(text, runId, model, result.result.usage),
          );
        }
      } catch (err) {
        deps.logger.error({ err, path }, "http api turn failed");
        sendJson(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      } finally {
        // Archive the phantom session so it doesn't pollute session.list.
        try {
          deps.sessions.setStatus(session.id, "ended");
        } catch (err) {
          deps.logger.warn(
            { err, sessionId: session.id },
            "http api: failed to archive phantom session",
          );
        }
      }
    },
  };
}

function safeName(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.function === "object" && obj.function !== null) {
      const fn = obj.function as Record<string, unknown>;
      if (typeof fn.name === "string") return fn.name;
    }
  }
  return "";
}

function authenticate(
  req: IncomingMessage,
  authenticator: Authenticator,
): { label?: string } | null {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  return authenticator.verify(m[1]!.trim());
}

interface FlatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

function extractMessages(path: string, body: Record<string, unknown>): FlatMessage[] {
  // OpenAI: { messages: [{role, content}] }
  // Anthropic: { messages: [...], system: "string" }
  const out: FlatMessage[] = [];
  if (path === "/v1/messages") {
    const sys = body.system;
    if (typeof sys === "string" && sys.length > 0) {
      out.push({ role: "system", content: sys });
    }
  }
  const arr = Array.isArray(body.messages) ? body.messages : [];
  for (const m of arr) {
    if (typeof m !== "object" || m === null) continue;
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    if (typeof content === "string") {
      out.push({ role, content });
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
        .map((b) => (b as Record<string, unknown>).text)
        .filter((t) => typeof t === "string")
        .join("\n");
      if (text.length > 0) out.push({ role, content: text });
    }
  }
  return out;
}

function extractAssistantText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .filter((b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b) => (b as Record<string, unknown>).text)
      .filter((t) => typeof t === "string")
      .join("");
  }
  return JSON.stringify(output ?? "");
}

interface UsageLike {
  inputTokens: number;
  outputTokens: number;
}

function renderOpenAi(text: string, id: string, model: string, usage: UsageLike) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

function renderAnthropic(text: string, id: string, model: string, usage: UsageLike) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  };
}

async function runStreamed(
  deps: HttpApiDeps,
  opts: {
    sessionId: string;
    runId: string;
    path: string;
    model: string;
    userContent: ContentBlock[];
    allowedTools: string[];
    res: ServerResponse;
  },
): Promise<void> {
  const { res, path, runId, model } = opts;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // Subscribe to text deltas for this run, forward them as SSE chunks.
  // Each chat.text_delta payload has { sessionId, runId, delta } — we filter
  // by runId so a parallel call on the same session doesn't bleed into ours.
  const writeChunk = (delta: string): void => {
    if (path === "/v1/messages") {
      const event = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } else {
      const event = {
        id: runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  // The broadcast API takes a Subscriber (with .send/.id) rather than a
  // callback. Wrap our chunk-writer as one. The Subscriber's id only needs
  // to be unique for removeAll cleanup.
  const subscriber = {
    id: `http_api_${runId}`,
    send(frame: { type: "event"; topic: string; data: unknown }) {
      const p = frame.data as { runId?: string; delta?: string };
      if (p && p.runId === runId && typeof p.delta === "string") writeChunk(p.delta);
    },
  };
  const topic = `chat.text_delta/${opts.sessionId}`;
  deps.broadcast.subscribe(subscriber, topic);
  const unsubscribe = (): void => deps.broadcast.unsubscribe(subscriber, topic);

  try {
    const result = await runChatTurn(
      {
        sessionId: opts.sessionId,
        runId,
        userContent: [],
        persistUserMessage: false,
        model,
        fallbacks: deps.defaultFallbacks,
        toolRegistry: deps.toolRegistry,
        cwd: deps.workspaceDir,
        toolsAllow: opts.allowedTools,
        ...(deps.clientOverride !== undefined ? { clientOverride: deps.clientOverride } : {}),
      },
      {
        sessions: deps.sessions,
        messages: deps.messages,
        toolCalls: deps.toolCalls,
        broadcast: deps.broadcast,
        logger: deps.logger,
        ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
        ...(deps.traceRegistry ? { traceRegistry: deps.traceRegistry } : {}),
      },
    );
    if (path === "/v1/messages") {
      const stop = {
        type: "message_stop",
        usage: {
          input_tokens: result.result.usage.inputTokens,
          output_tokens: result.result.usage.outputTokens,
        },
      };
      res.write(`data: ${JSON.stringify(stop)}\n\n`);
    } else {
      res.write(
        `data: ${JSON.stringify({
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
    }
    res.end();
  } finally {
    unsubscribe();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
