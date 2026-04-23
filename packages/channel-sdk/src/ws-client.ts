import WebSocket from "ws";
import { randomUUID } from "node:crypto";
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

export interface SquadGatewayClientOptions {
  url: string;
  token: string;
  /** Exponential backoff cap, ms. Default 30000. */
  maxBackoffMs?: number;
}

/**
 * A reconnecting WebSocket client with a `request(method, params)` helper.
 * Used by out-of-process channels; the in-process channel adapter talks to
 * the gateway's stores directly.
 */
export class SquadGatewayClient {
  private ws: WebSocket | null = null;
  private readonly pending: Map<string, (frame: Frame) => void> = new Map();
  private readonly listeners: Set<EventHandler> = new Set();
  private closed = false;
  private backoffMs = 500;
  private readonly subscriptions: Set<string> = new Set();

  constructor(private readonly options: SquadGatewayClientOptions) {}

  async connect(): Promise<void> {
    await this.openSocket();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  onEvent(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async subscribe(topics: string[]): Promise<void> {
    for (const t of topics) this.subscriptions.add(t);
    await this.sendRaw({
      type: "subscribe",
      id: randomUUID(),
      topics: topics as [string, ...string[]],
    });
  }

  async request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    const response = await this.sendRaw({
      type: "request",
      id: randomUUID(),
      method,
      params: params as unknown,
    });
    if (response.type !== "response") {
      throw new Error(`unexpected frame for response: ${response.type}`);
    }
    if (!response.ok) {
      throw new ProtocolError(response.error.code, response.error.message, response.error.data);
    }
    return response.result as MethodResult<M>;
  }

  private async openSocket(): Promise<void> {
    const url = this.options.url.includes("token=")
      ? this.options.url
      : `${this.options.url}${this.options.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.options.token)}`;
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => resolve());
      this.ws!.once("error", reject);
    });
    this.backoffMs = 500;
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("close", () => {
      if (this.closed) return;
      void this.reconnect();
    });
    // Re-send any subscriptions we accumulated during the last session.
    if (this.subscriptions.size > 0) {
      const topics = Array.from(this.subscriptions);
      await this.sendRaw({
        type: "subscribe",
        id: randomUUID(),
        topics: topics as [string, ...string[]],
      });
    }
  }

  private async reconnect(): Promise<void> {
    const cap = this.options.maxBackoffMs ?? 30_000;
    await new Promise((r) => setTimeout(r, this.backoffMs));
    this.backoffMs = Math.min(this.backoffMs * 2, cap);
    try {
      await this.openSocket();
    } catch {
      // Retry again after backoff.
      if (!this.closed) void this.reconnect();
    }
  }

  private async sendRaw(frame: Frame & { id: string }): Promise<Frame> {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      throw new Error("not connected");
    }
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
