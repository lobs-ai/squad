import WebSocket from "ws";
import {
  parseFrameString,
  ProtocolError,
  type Frame,
  type EventFrame,
  type RequestFrame,
  type MethodName,
  type methodRegistry,
} from "@squad/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";

type MethodParams<M extends MethodName> = z.infer<(typeof methodRegistry)[M]["params"]>;
type MethodResult<M extends MethodName> = z.infer<(typeof methodRegistry)[M]["result"]>;

export type EventHandler = (topic: string, data: unknown) => void;

export interface ProtocolClientOptions {
  url: string;
  token: string;
}

/**
 * A minimal, self-contained protocol client. The CLI and any third-party
 * client can wrap this — all the wire complexity lives here.
 */
export class ProtocolClient {
  private ws: WebSocket | null = null;
  private readonly pending: Map<string, (frame: Frame) => void> = new Map();
  private readonly listeners: Set<EventHandler> = new Set();

  constructor(private readonly options: ProtocolClientOptions) {}

  async connect(): Promise<void> {
    const url = this.options.url.includes("token=")
      ? this.options.url
      : `${this.options.url}${this.options.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.options.token)}`;
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => resolve());
      this.ws!.once("error", (err: Error & { code?: string; errors?: Error[] }) => {
        // Node 22+ surfaces connection failures as an AggregateError (one per
        // resolved address — typically ::1 and 127.0.0.1). Its .message is
        // empty; the actual reason lives on .code or .errors[0].
        const inner = err?.errors?.[0];
        const detail = err.message || inner?.message || err.code || "connection failed";
        const wrapped = new Error(detail);
        if (err.code) (wrapped as Error & { code?: string }).code = err.code;
        reject(wrapped);
      });
    });
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
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
      id: randomUUID(),
      topics: topics as [string, ...string[]],
    });
  }

  async unsubscribe(topics: string[]): Promise<void> {
    await this.sendFrame({
      type: "unsubscribe",
      id: randomUUID(),
      topics: topics as [string, ...string[]],
    });
  }

  async request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    const frame: RequestFrame = {
      type: "request",
      id: randomUUID(),
      method,
      params: params as unknown,
    };
    const response = await this.sendFrame(frame);
    if (response.type !== "response") {
      throw new Error(`unexpected frame type for response: ${response.type}`);
    }
    if (!response.ok) {
      throw new ProtocolError(response.error.code, response.error.message, response.error.data);
    }
    return response.result as MethodResult<M>;
  }

  private async sendFrame(
    frame:
      | RequestFrame
      | { type: "subscribe" | "unsubscribe"; id: string; topics: [string, ...string[]] },
  ): Promise<Frame> {
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
