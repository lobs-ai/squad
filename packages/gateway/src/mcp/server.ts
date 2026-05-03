import type { Readable, Writable } from "node:stream";
import type { ToolRegistry } from "@squad/tools";
import type { Logger } from "../logger.js";

/**
 * Squad-as-MCP-server: speak the MCP wire protocol over a pair of
 * Readable/Writable streams (typically stdin/stdout when invoked as a
 * subprocess via `squad mcp serve`). Exposes the gateway's `ToolRegistry`
 * as MCP tools so external clients (Claude Desktop, Cursor, …) can use
 * Squad's tools directly.
 *
 * Scope: stdio + tools/list + tools/call. The reverse-direction protocol
 * is what people actually use; resources/prompts/sampling are not on
 * the v1 path.
 */

export interface McpServerOptions {
  toolRegistry: ToolRegistry;
  logger: Logger;
  /** Working dir handed to every tool call. */
  cwd: string;
  /** When set, only these tool names are exposed. */
  allow?: string[];
  /** Tool names hidden from the MCP client even when the registry has them. */
  deny?: string[];
}

export function createMcpServer(opts: McpServerOptions, input: Readable, output: Writable): {
  start: () => void;
} {
  const filterTools = (): string[] => {
    let names = opts.toolRegistry.names();
    if (opts.allow && opts.allow.length > 0) {
      const allow = new Set(opts.allow);
      names = names.filter((n) => allow.has(n));
    }
    if (opts.deny && opts.deny.length > 0) {
      const deny = new Set(opts.deny);
      names = names.filter((n) => !deny.has(n));
    }
    return names;
  };

  const writeFrame = (msg: Record<string, unknown>): void => {
    output.write(JSON.stringify(msg) + "\n");
  };

  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        opts.logger.warn({ line }, "mcp server: invalid JSON-RPC frame");
        continue;
      }
      void handle(msg).catch((err) => {
        opts.logger.error({ err, method: msg.method }, "mcp server handler threw");
      });
    }
  };

  const handle = async (msg: Record<string, unknown>): Promise<void> => {
    const id = msg.id;
    const method = msg.method;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (method === "initialize") {
      writeFrame({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "squad-gateway", version: "0.0.0" },
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      const tools = filterTools().flatMap((name) => {
        const def = opts.toolRegistry.get(name);
        if (!def) return [];
        return [{
          name: def.name,
          description: def.description,
          inputSchema: def.input_schema,
        }];
      });
      writeFrame({ jsonrpc: "2.0", id, result: { tools } });
      return;
    }

    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await opts.toolRegistry.execute(name, args, opts.cwd);
        writeFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          },
        });
      } catch (err) {
        opts.logger.warn({ err, tool: name }, "mcp server: tools/call failed");
        writeFrame({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              { type: "text", text: err instanceof Error ? err.message : String(err) },
            ],
          },
        });
      }
      return;
    }

    if (typeof id !== "undefined") {
      writeFrame({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      });
    }
  };

  return {
    start() {
      input.setEncoding?.("utf8");
      input.on("data", onData);
    },
  };
}
