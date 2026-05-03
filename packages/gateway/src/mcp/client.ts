import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Logger } from "../logger.js";

/**
 * Minimal MCP (Model Context Protocol) client over stdio. Speaks JSON-RPC 2.0
 * with newline-delimited messages — that's what every MCP stdio server emits.
 *
 * Scope: initialize handshake + `tools/list` + `tools/call`. Resources,
 * prompts, sampling, and notifications other than tool-list-changed are
 * not implemented — they're unused by Squad's tool-first integration.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpClientOptions {
  /** Logical id used for logging + namespacing tool names. */
  serverId: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  logger: Logger;
  /** Per-call timeout for tools/call (ms). Default 60s. */
  callTimeoutMs?: number;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private buffer = "";
  private initialized = false;
  private toolList: McpToolDefinition[] = [];
  private readonly callTimeoutMs: number;

  constructor(private readonly opts: McpClientOptions) {
    super();
    this.callTimeoutMs = opts.callTimeoutMs ?? 60_000;
  }

  async start(): Promise<void> {
    this.child = spawn(this.opts.command, this.opts.args ?? [], {
      env: { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.opts.logger.warn(
        { serverId: this.opts.serverId, line: chunk.trim() },
        "mcp server stderr",
      );
    });
    this.child.on("exit", (code, signal) => {
      this.opts.logger.warn(
        { serverId: this.opts.serverId, code, signal },
        "mcp server exited",
      );
      const err = new Error(`mcp server "${this.opts.serverId}" exited (code=${code}, signal=${signal})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    // Initialize handshake.
    const initResult = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "squad-gateway", version: "0.0.0" },
    })) as { capabilities?: { tools?: unknown } };
    this.initialized = true;
    this.opts.logger.info(
      { serverId: this.opts.serverId, hasTools: !!initResult.capabilities?.tools },
      "mcp server initialized",
    );
    // Some servers expect a `notifications/initialized` after the initialize
    // response; emit it best-effort.
    this.notify("notifications/initialized", {});

    await this.refreshTools();
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.stdin?.end();
    } catch (err) {
      this.opts.logger.debug(
        { err, serverId: this.opts.serverId },
        "mcp stop: stdin.end() failed",
      );
    }
    child.kill("SIGTERM");
    this.opts.logger.info({ serverId: this.opts.serverId }, "mcp server stopping (SIGTERM)");
    // Hard-kill if it hangs around for >2s.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (err) {
        this.opts.logger.debug(
          { err, serverId: this.opts.serverId },
          "mcp stop: SIGKILL failed (process likely already exited)",
        );
      }
    }, 2_000).unref();
  }

  /** Re-fetch tool definitions from the server. Called on `tools/list_changed`. */
  async refreshTools(): Promise<McpToolDefinition[]> {
    if (!this.initialized) throw new Error("not initialized");
    const result = (await this.request("tools/list", {})) as { tools?: unknown };
    const tools = Array.isArray(result.tools) ? result.tools : [];
    this.toolList = tools
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => normalizeTool(t));
    this.emit("tools_changed", this.toolList);
    return this.toolList;
  }

  /** Most recent set of tool definitions. */
  tools(): McpToolDefinition[] {
    return [...this.toolList];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<Record<string, unknown>>;
      isError?: boolean;
    };
    if (result.isError) {
      const text = (result.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      throw new Error(text || `mcp tool "${name}" returned error`);
    }
    // Collapse the content array into the simplest representation —
    // text-only → string; otherwise → original blocks.
    const blocks = result.content ?? [];
    if (blocks.every((b) => b.type === "text" && typeof b.text === "string")) {
      return blocks.map((b) => b.text as string).join("\n");
    }
    return blocks;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.dispatch(msg);
      } catch (err) {
        this.opts.logger.warn(
          { serverId: this.opts.serverId, err, line },
          "mcp invalid JSON-RPC frame",
        );
      }
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = msg.error as { message?: string };
        pending.reject(new Error(err.message ?? "mcp rpc error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    // Notification.
    if (msg.method === "notifications/tools/list_changed") {
      void this.refreshTools().catch((err) => {
        this.opts.logger.error(
          { serverId: this.opts.serverId, err },
          "failed to refresh mcp tools after list_changed",
        );
      });
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child) throw new Error("mcp client not started");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${method} timed out after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin!.write(payload);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    try {
      this.child.stdin!.write(payload);
    } catch (err) {
      this.opts.logger.debug(
        { err, serverId: this.opts.serverId, method },
        "mcp notify failed (fire-and-forget)",
      );
    }
  }
}

function normalizeTool(t: Record<string, unknown>): McpToolDefinition {
  const name = typeof t.name === "string" ? t.name : "unknown";
  const description = typeof t.description === "string" ? t.description : "";
  const schema = (t.inputSchema ?? t.input_schema ?? { type: "object" }) as Record<string, unknown>;
  return {
    name,
    description,
    input_schema: {
      type: "object",
      ...(typeof schema.properties === "object" && schema.properties !== null
        ? { properties: schema.properties as Record<string, unknown> }
        : {}),
      ...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
    },
  };
}
