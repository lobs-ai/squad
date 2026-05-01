import type { ToolRegistry, ToolEntry } from "@squad/tools";
import type { Logger } from "../logger.js";
import { McpClient, type McpToolDefinition } from "./client.js";

/**
 * Configuration for one MCP server. Mirrors `config.mcp.servers[]`.
 *
 * `allow` and `deny` are tool-name lists evaluated against each server's
 * advertised tools. When `allow` is set, only matching tools are imported.
 * `deny` always takes precedence. Names are matched against the server's
 * native name (no namespace prefix).
 *
 * `sample` is the soft cap the server should be allowed to expose. When the
 * server advertises more tools than `sample`, we keep the first N — alphabetical
 * — to avoid blowing up the system prompt. The runtime `describe_tool_group`
 * mechanism handles the rest.
 */
export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  allow?: string[];
  deny?: string[];
  sample?: number;
  /** Tag every imported tool gets — useful for approval policies. */
  tags?: string[];
}

export interface McpRegistryDeps {
  toolRegistry: ToolRegistry;
  logger: Logger;
}

interface LoadedServer {
  config: McpServerConfig;
  client: McpClient;
  registeredNames: Set<string>;
}

/**
 * Owns N MCP servers. On `load(config)` it spawns the server, fetches its
 * tools, applies allow/deny/sample, and registers each as a `ToolEntry` in
 * the gateway's `ToolRegistry`. The agent loop sees them as native tools —
 * no second-class dispatch path.
 */
export class McpRegistry {
  private readonly servers = new Map<string, LoadedServer>();

  constructor(private readonly deps: McpRegistryDeps) {}

  /**
   * Spawn one MCP server and import its tools. Idempotent: calling load()
   * twice for the same server id reloads it (stop existing → start fresh).
   */
  async load(config: McpServerConfig): Promise<void> {
    const existing = this.servers.get(config.id);
    if (existing) await this.unload(config.id);

    const client = new McpClient({
      serverId: config.id,
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      logger: this.deps.logger,
    });
    await client.start();

    const registered = new Set<string>();
    const importTools = (tools: McpToolDefinition[]): void => {
      // Drop everything we previously imported for this server, then re-import.
      for (const name of registered) this.unregisterTool(name);
      registered.clear();
      const filtered = applyFilters(tools, config);
      for (const tool of filtered) {
        const namespaced = namespacedName(config.id, tool.name);
        const entry: ToolEntry = {
          definition: {
            name: namespaced,
            description: tool.description,
            input_schema: tool.input_schema,
            ...(config.tags ? { tags: config.tags } : { tags: ["mcp"] }),
          },
          executor: async (params) => {
            const r = await client.callTool(tool.name, params as Record<string, unknown>);
            // ToolExecutorResult requires string | { result, sideEffects }.
            // MCP responses are text-or-blocks — collapse blocks to JSON for
            // non-text content so the runner gets a stable string back.
            if (typeof r === "string") return r;
            return JSON.stringify(r);
          },
        };
        this.deps.toolRegistry.register(entry);
        registered.add(namespaced);
      }
      this.deps.logger.info(
        { serverId: config.id, count: registered.size, advertised: tools.length },
        "mcp tools imported",
      );
    };

    importTools(client.tools());
    client.on("tools_changed", (tools: McpToolDefinition[]) => importTools(tools));

    this.servers.set(config.id, { config, client, registeredNames: registered });
  }

  async unload(id: string): Promise<void> {
    const loaded = this.servers.get(id);
    if (!loaded) return;
    for (const name of loaded.registeredNames) this.unregisterTool(name);
    await loaded.client.stop();
    this.servers.delete(id);
    this.deps.logger.info({ serverId: id }, "mcp server unloaded");
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.servers.keys()]) {
      try {
        await this.unload(id);
      } catch (err) {
        this.deps.logger.error({ err, serverId: id }, "failed to unload mcp server");
      }
    }
  }

  /** Snapshot of currently loaded servers — useful for `mcp.list` admin RPC. */
  list(): Array<{ id: string; toolCount: number; tools: string[] }> {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.config.id,
      toolCount: s.registeredNames.size,
      tools: [...s.registeredNames],
    }));
  }

  /**
   * The vendored ToolRegistry doesn't expose deletion, so we stash a
   * delete shim here that pokes the underlying map. Hidden from the public
   * BaseTool API to keep the contract narrow — only the MCP path needs it.
   */
  private unregisterTool(name: string): void {
    const reg = this.deps.toolRegistry as unknown as {
      _tools?: Map<string, unknown>;
    };
    reg._tools?.delete(name);
  }
}

function applyFilters(tools: McpToolDefinition[], cfg: McpServerConfig): McpToolDefinition[] {
  let filtered = tools;
  if (cfg.allow && cfg.allow.length > 0) {
    const allow = new Set(cfg.allow);
    filtered = filtered.filter((t) => allow.has(t.name));
  }
  if (cfg.deny && cfg.deny.length > 0) {
    const deny = new Set(cfg.deny);
    filtered = filtered.filter((t) => !deny.has(t.name));
  }
  if (typeof cfg.sample === "number" && cfg.sample > 0 && filtered.length > cfg.sample) {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name)).slice(0, cfg.sample);
  }
  return filtered;
}

function namespacedName(serverId: string, toolName: string): string {
  // Sanitize: tool names must be `[A-Za-z0-9_-]+` for most LLM APIs.
  const safeServer = serverId.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeTool = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${safeServer}__${safeTool}`;
}
