/**
 * Squad MCP control plane for the Claude harness — in-process.
 *
 * The squad primitives (ask_user / create_task / spawn_subagent / reply /
 * memory …) become tools on an in-process SDK MCP server: direct function
 * calls in the gateway process, no subprocess, no stdio, no catalog round-trip.
 * Each tool forwards to the gateway's executor and returns its text.
 *
 * Native leaf tools (Read/Edit/Bash/Grep/Web) are NOT here — those stay with
 * the harness; only squad-specific primitives are exposed via MCP.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { jsonSchemaToZodShape } from "./json-schema-to-zod.js";
import type { SquadToolset } from "../types.js";

export const SQUAD_MCP_SERVER_NAME = "squad";

/** Build the in-process MCP server exposing this turn's squad primitives. */
export function buildSquadSdkMcpServer(squadTools: SquadToolset): McpSdkServerConfigWithInstance {
  const tools = squadTools.tools.map((def) =>
    tool(
      def.name,
      def.description,
      jsonSchemaToZodShape(def.inputSchema),
      async (args: Record<string, unknown>) => {
        try {
          const text = await squadTools.execute(def.name, args);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            content: [
              { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  return createSdkMcpServer({
    name: SQUAD_MCP_SERVER_NAME,
    version: "0.0.0",
    tools,
  });
}
