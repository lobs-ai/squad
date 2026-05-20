/**
 * OpenAI Codex (ChatGPT subscription) provider.
 *
 * The Codex endpoint at `https://chatgpt.com/backend-api/codex/responses`
 * speaks OpenAI's Responses API, not Chat Completions. This client
 * converts squad's `LLMMessage` history into Responses-API `input`
 * frames, parses the SSE stream the endpoint returns, and surfaces the
 * final response in squad's shared `LLMResponse` shape.
 *
 * Authentication is decoupled from the request layer: the constructor
 * takes a `tokenProvider` callback that returns a fresh access token +
 * account id. The wiring in `client.ts` plugs in a `CodexAuthService`
 * instance, which transparently refreshes the access token when it
 * nears expiry. Storage-agnostic — the client itself never touches the
 * filesystem.
 *
 * Adapted from lobs-core's `OpenAICodexClient` (Apache-2.0).
 */
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  CreateMessageParams,
  ContentBlock,
  StopReason,
  TokenUsage,
} from "../types.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexTokenProvider {
  /** Return a non-expired bearer token. May refresh in the background. */
  getAccessToken(): Promise<string>;
  /** ChatGPT-Account-Id header value. Derived from the JWT when not set. */
  getAccountId?: () => string | undefined;
  /**
   * Invoked when the endpoint rejects the access token with 401. Should
   * force a refresh so the next attempt picks up a fresh access token.
   * The client itself does not retry; the caller's resilient client
   * handles retries.
   */
  forceRefresh?: () => Promise<void>;
}

export interface OpenAICodexClientOptions {
  tokenProvider: CodexTokenProvider;
  /** Override the base URL — useful for tests / future proxies. */
  baseUrl?: string;
  /**
   * Optional sticky session id. Passed as `prompt_cache_key` so multiple
   * turns of the same conversation can hit the prompt cache.
   */
  sessionId?: string;
  /**
   * Extra headers added to every request. Lets the gateway thread
   * deployment-specific identifiers without modifying this file.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Shape of an item in the Responses API `output` array. Loosely typed
 * because the upstream API adds new item types over time and we only
 * care about the ones squad surfaces.
 */
interface ResponsesOutputItem {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesFinal {
  output?: ResponsesOutputItem[];
  status?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class OpenAICodexClient implements LLMClient {
  private readonly tokenProvider: CodexTokenProvider;
  private readonly baseUrl: string;
  private readonly sessionId: string | undefined;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAICodexClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.sessionId = options.sessionId;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async createMessage(params: CreateMessageParams): Promise<LLMResponse> {
    const body = this.buildRequestBody(params);
    const sseText = await this.postRequest(body);
    const final = extractFinalFromSSE(sseText);
    return convertResponse(final);
  }

  async streamMessage(
    params: CreateMessageParams,
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    // The Codex endpoint always streams SSE — we just hand text deltas to
    // `onChunk` as they arrive instead of waiting for the final event.
    const body = this.buildRequestBody(params);
    const final = await this.postRequestStreaming(body, onChunk);
    return convertResponse(final);
  }

  private buildRequestBody(params: CreateMessageParams): Record<string, unknown> {
    const input = convertMessagesToInput(params.messages);
    const tools = params.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      strict: false,
    }));
    const body: Record<string, unknown> = {
      model: params.model,
      store: false,
      stream: true,
      instructions: params.system,
      input,
      text: { verbosity: "medium" },
      // The Codex endpoint requires this `include` for reasoning models;
      // omitting it makes the server drop encrypted reasoning state across
      // turns. Harmless for non-reasoning models.
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
      ...(this.sessionId ? { prompt_cache_key: this.sessionId } : {}),
    };
    if (tools.length > 0) body.tools = tools;
    return body;
  }

  /** Buffered POST — returns the full SSE body as a single string. */
  private async postRequest(body: Record<string, unknown>): Promise<string> {
    const response = await this.fetchWithAuth(body);
    return response.text();
  }

  /** Streaming POST — yields text deltas to `onChunk` as they arrive. */
  private async postRequestStreaming(
    body: Record<string, unknown>,
    onChunk: (text: string) => void,
  ): Promise<ResponsesFinal> {
    const response = await this.fetchWithAuth(body);
    if (!response.body) {
      // node-fetch / undici always exposes a body for 2xx responses, but
      // belt + braces in case of a polyfill — fall back to the buffered
      // path so we still produce a real response.
      const text = await response.text();
      return extractFinalFromSSE(text, onChunk);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalResponse: ResponsesFinal | null = null;
    let responseError: string | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete SSE event-blocks (separated by blank lines).
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseSSEEvent(chunk);
        if (!event) continue;
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          onChunk(event.delta);
        } else if (
          event.type === "response.completed" ||
          event.type === "response.done" ||
          event.type === "response.incomplete"
        ) {
          finalResponse = event.response as ResponsesFinal;
        } else if (event.type === "response.failed") {
          const errorObj = (event.response as { error?: { message?: string } } | undefined)?.error;
          responseError = errorObj?.message ?? "Codex response failed";
        } else if (event.type === "error") {
          responseError = String(
            (event as { message?: string; code?: string }).message ??
              (event as { code?: string }).code ??
              "Codex error",
          );
        }
      }
    }
    if (!finalResponse) {
      throw new CodexProviderError(
        responseError ?? "Codex SSE ended without a final response event",
      );
    }
    return finalResponse;
  }

  private async fetchWithAuth(body: Record<string, unknown>): Promise<Response> {
    const send = async (): Promise<Response> => {
      const access = await this.tokenProvider.getAccessToken();
      const accountId = this.tokenProvider.getAccountId?.();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${access}`,
        accept: "text/event-stream",
        "content-type": "application/json",
        // The Codex endpoint sits behind the Responses API beta gate.
        "OpenAI-Beta": "responses=experimental",
        originator: "squad",
        "User-Agent": `squad-llm (${process.platform} ${process.arch})`,
        ...this.extraHeaders,
      };
      if (accountId) headers["chatgpt-account-id"] = accountId;
      if (this.sessionId) headers["session_id"] = this.sessionId;
      return fetch(this.resolveEndpoint(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
    };

    let response = await send();
    if (response.status === 401 && this.tokenProvider.forceRefresh) {
      // Server-side rejection of a token we believed valid — force a
      // refresh and retry once. Surfaces a clean error to the resilient
      // client when even the refreshed token gets rejected.
      try {
        await this.tokenProvider.forceRefresh();
      } catch (err) {
        throw new CodexProviderError(
          `Codex 401 and refresh failed: ${(err as Error).message}`,
          { status: 401 },
        );
      }
      response = await send();
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new CodexProviderError(
        `Codex API ${response.status}: ${text.slice(0, 500) || response.statusText}`,
        { status: response.status },
      );
    }
    return response;
  }

  private resolveEndpoint(): string {
    const normalized = this.baseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }
}

/** Errors from the provider carry an HTTP status when one is available. */
export class CodexProviderError extends Error {
  status?: number;
  constructor(message: string, opts?: { status?: number }) {
    super(message);
    this.name = "CodexProviderError";
    if (opts?.status !== undefined) this.status = opts.status;
  }
}

// ── Message + response conversion ────────────────────────────────────────────

function convertMessagesToInput(messages: LLMMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
        continue;
      }
      const userContent: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          // Tool results travel at top-level as function_call_output —
          // not nested under a user message — to match what Responses API
          // expects.
          input.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output:
              typeof b.content === "string"
                ? b.content
                : JSON.stringify(b.content),
          });
        } else if (b.type === "text" && typeof b.text === "string") {
          userContent.push({ type: "input_text", text: b.text });
        } else if (
          b.type === "image" &&
          typeof b.data === "string" &&
          typeof b.mediaType === "string"
        ) {
          userContent.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${b.mediaType};base64,${b.data}`,
          });
        }
      }
      if (userContent.length > 0) input.push({ role: "user", content: userContent });
      continue;
    }
    // assistant
    if (typeof msg.content === "string") {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: msg.content, annotations: [] }],
        status: "completed",
      });
      continue;
    }
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: b.text, annotations: [] }],
          status: "completed",
        });
      } else if (b.type === "tool_use") {
        const id = String(b.id ?? "");
        input.push({
          type: "function_call",
          call_id: id,
          // The Responses API expects an `fc_…` prefix on the inner id.
          // We keep the original `id` as the call_id so future tool_result
          // blocks line up.
          id: id.startsWith("fc_") ? id : `fc_${id}`,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
    }
  }
  return input;
}

function convertResponse(response: ResponsesFinal): LLMResponse {
  const content: ContentBlock[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const block of item.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        }
      }
    } else if (item.type === "function_call") {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(item.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        /* keep empty object */
      }
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id ?? "",
        name: item.name ?? "",
        input,
      });
    }
  }
  const stopReason: StopReason = content.some((c) => c.type === "tool_use")
    ? "tool_use"
    : response.status === "incomplete"
      ? "max_tokens"
      : "end_turn";
  const usage: TokenUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stopReason,
    usage,
  };
}

// ── SSE parsing ──────────────────────────────────────────────────────────────

interface SSEEvent {
  type?: string;
  delta?: string;
  response?: unknown;
  [key: string]: unknown;
}

function parseSSEEvent(chunk: string): SSEEvent | null {
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as SSEEvent;
  } catch {
    return null;
  }
}

/**
 * Parse a buffered SSE body — used by the non-streaming path and as a
 * fallback when the stream's `body` is missing.
 *
 * Optionally drips text deltas through `onChunk` for the streaming
 * fallback path.
 */
function extractFinalFromSSE(
  sseText: string,
  onChunk?: (text: string) => void,
): ResponsesFinal {
  let finalResponse: ResponsesFinal | null = null;
  let responseError: string | null = null;
  for (const chunk of sseText.split("\n\n")) {
    const event = parseSSEEvent(chunk);
    if (!event) continue;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      onChunk?.(event.delta);
    } else if (
      event.type === "response.completed" ||
      event.type === "response.done" ||
      event.type === "response.incomplete"
    ) {
      finalResponse = event.response as ResponsesFinal;
    } else if (event.type === "response.failed") {
      const errorObj = (event.response as { error?: { message?: string } } | undefined)?.error;
      responseError = errorObj?.message ?? "Codex response failed";
    } else if (event.type === "error") {
      responseError = String(
        (event as { message?: string; code?: string }).message ??
          (event as { code?: string }).code ??
          "Codex error",
      );
    }
  }
  if (!finalResponse) {
    throw new CodexProviderError(
      responseError ?? "Codex SSE ended without a final response event",
    );
  }
  return finalResponse;
}

// Exposed for unit tests.
export const __INTERNAL = {
  convertMessagesToInput,
  convertResponse,
  extractFinalFromSSE,
  parseSSEEvent,
};
