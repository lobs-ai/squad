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

function nextId(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Browser-side copy of the minimal protocol client. Same shape as the CLI's
 * version — just uses the platform WebSocket. Third-party UIs can drop this
 * in unchanged.
 */
export class BrowserProtocolClient {
  private ws: WebSocket | null = null;
  private readonly pending: Map<string, (frame: Frame) => void> = new Map();
  private readonly listeners: Set<EventHandler> = new Set();

  constructor(private readonly url: string, private readonly token: string) {}

  async connect(): Promise<void> {
    const full = `${this.url}${this.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(full);
    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener("open", () => resolve());
      this.ws!.addEventListener("error", () => reject(new Error("ws error")));
    });
    this.ws.addEventListener("message", (ev) => this.handleMessage(ev.data as string));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  onEvent(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async subscribe(topics: string[]): Promise<void> {
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
