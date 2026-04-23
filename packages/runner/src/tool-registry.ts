// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/tool-registry.ts
// Last synced: 2026-04-23

/**
 * Tool registry — maps tool names to definitions and executors.
 *
 * This is a minimal registry that delegates to the @agentic/tools package
 * when available, or falls back to a no-op. It provides the seam between
 * the runner loop and any tool implementation layer.
 *
 * In production lobs-core usage the toolExecutor field on AgentSpec is
 * used instead, so this registry serves as the default fallback.
 */

import type { ToolDefinition } from "@squad/llm";
import type { ToolResult } from "./types.js";

// ── Tool Entry ────────────────────────────────────────────────────────────────

export interface ToolEntry {
  definition: ToolDefinition;
  execute: (
    params: Record<string, unknown>,
    cwd: string,
  ) => Promise<{ output: string; isError?: boolean }>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const tools = new Map<string, ToolEntry>();

/**
 * Register a tool implementation.
 */
export function registerTool(name: string, entry: ToolEntry): void {
  tools.set(name, entry);
}

/**
 * Get tool definitions for the given tool names (or all registered tools).
 */
export function getToolDefinitions(names?: string[]): ToolDefinition[] {
  if (!names || names.length === 0) {
    return Array.from(tools.values()).map((t) => t.definition);
  }
  const defs: ToolDefinition[] = [];
  for (const name of names) {
    const entry = tools.get(name);
    if (entry) defs.push(entry.definition);
  }
  return defs;
}

/**
 * Execute a tool by name.
 *
 * Returns a ToolResult. Errors are captured and returned as error results
 * rather than thrown, so the agent loop can handle them gracefully.
 */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  toolUseId: string,
  cwd: string,
): Promise<ToolResult> {
  const entry = tools.get(name);

  if (!entry) {
    return {
      toolUseId,
      content: `Unknown tool: ${name}`,
      is_error: true,
    };
  }

  try {
    const result = await entry.execute(params, cwd);
    return {
      toolUseId,
      content: result.output,
      is_error: result.isError ?? false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      toolUseId,
      content: `Tool ${name} threw an error: ${msg}`,
      is_error: true,
    };
  }
}
