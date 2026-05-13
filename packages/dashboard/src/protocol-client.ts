import {
  parseFrameString,
  ProtocolError,
  type Frame,
  type EventFrame,
  type MethodName,
  type methodRegistry,
} from "@squad/protocol";
import type { z } from "zod";

type MethodParams<M extends MethodName> = z.infer<(typeof methodRegistry)[M]["params"]>;
type MethodResult<M extends MethodName> = z.infer<(typeof methodRegistry)[M]["result"]>;

export type EventHandler = (topic: string, data: unknown) => void;
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";
export type ConnectionHandler = (status: ConnectionStatus) => void;

function nextId(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Browser-side copy of the minimal protocol client. Same shape as the CLI's
 * version — just uses the platform WebSocket. Third-party UIs can drop this
 * in unchanged.
 *
 * Reconnection: a `connect()` call arms the client for the rest of its
 * lifetime. If the underlying socket drops (network blip, gateway restart,
 * laptop sleep), the client transparently retries with exponential backoff
 * and replays every prior `subscribe()` so the dashboard keeps receiving
 * events. In-flight requests are rejected since their response never lands;
 * callers handle that themselves (the chat composer surfaces it as a banner).
 */
export class BrowserProtocolClient {
  private ws: WebSocket | null = null;
  private readonly pending: Map<string, (frame: Frame) => void> = new Map();
  private readonly listeners: Set<EventHandler> = new Set();
  private readonly connectionListeners: Set<ConnectionHandler> = new Set();
  private readonly subscriptions: Set<string> = new Set();
  private status: ConnectionStatus = "closed";
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly token: string) {}

  async connect(): Promise<void> {
    this.closed = false;
    await this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }

  onEvent(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionListeners.add(handler);
    // Surface the current status immediately so newly-mounted listeners
    // render the right banner without waiting for the next transition.
    handler(this.status);
    return () => this.connectionListeners.delete(handler);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  async subscribe(topics: string[]): Promise<void> {
    for (const t of topics) this.subscriptions.add(t);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    await this.sendFrame({
      type: "subscribe",
      id: nextId(),
      topics: topics as [string, ...string[]],
    });
  }

  async request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    const response = await this.sendFrame({
      type: "request",
      id: nextId(),
      method,
      params: params as unknown,
    });
    if (response.type !== "response") {
      throw new Error(`unexpected frame: ${response.type}`);
    }
    if (!response.ok) {
      throw new ProtocolError(response.error.code, response.error.message, response.error.data);
    }
    return response.result as MethodResult<M>;
  }

  private async openSocket(): Promise<void> {
    this.setStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const full = `${this.url}${this.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(full);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (): void => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        reject(new Error("ws error"));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    ws.addEventListener("message", (ev) => this.handleMessage(ev.data as string));
    ws.addEventListener("close", () => this.handleClose());
    this.reconnectAttempt = 0;
    this.setStatus("open");
    // Replay subscriptions so the gateway resumes pushing events after a
    // reconnect. On the initial connect this is a no-op (set is empty).
    if (this.subscriptions.size > 0) {
      try {
        await this.sendFrame({
          type: "subscribe",
          id: nextId(),
          topics: Array.from(this.subscriptions) as [string, ...string[]],
        });
      } catch {
        // If the replay fails, the close handler will trigger another retry.
      }
    }
  }

  private handleClose(): void {
    // Reject every pending request so callers don't hang forever on a
    // response that's never coming. We synthesize a `cancelled` response so
    // it surfaces through the normal `request()` rejection path — callers
    // already handle that as a thrown ProtocolError.
    for (const [id, resolve] of this.pending) {
      resolve({
        type: "response",
        id,
        ok: false,
        error: { code: "cancelled", message: "websocket closed before response" },
      });
    }
    this.pending.clear();
    this.ws = null;
    if (this.closed) {
      this.setStatus("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.setStatus("reconnecting");
    // Exponential backoff capped at 10s, with a small jitter so a stampede
    // of dashboards reconnecting to a restarted gateway doesn't all hit the
    // socket on the same tick.
    const base = Math.min(10_000, 500 * Math.pow(2, this.reconnectAttempt));
    const delay = base + Math.floor(Math.random() * 250);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private setStatus(next: ConnectionStatus): void {
    if (next === this.status) return;
    this.status = next;
    for (const h of this.connectionListeners) h(next);
  }

  private async sendFrame(
    frame:
      | { type: "request"; id: string; method: string; params: unknown }
      | { type: "subscribe" | "unsubscribe"; id: string; topics: [string, ...string[]] },
  ): Promise<Frame> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
    const done = new Promise<Frame>((resolve) => this.pending.set(frame.id, resolve));
    this.ws.send(JSON.stringify(frame));
    return done;
  }

  private handleMessage(raw: string): void {
    let frame: Frame;
    try {
      frame = parseFrameString(raw);
    } catch {
      return;
    }
    if (frame.type === "response") {
      const waiter = this.pending.get(frame.id);
      if (waiter) {
        this.pending.delete(frame.id);
        waiter(frame);
      }
      return;
    }
    if (frame.type === "event") {
      const evt = frame as EventFrame;
      for (const handler of this.listeners) handler(evt.topic, evt.data);
    }
  }
}
