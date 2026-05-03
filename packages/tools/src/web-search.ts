/**
 * WebSearchTool — search the web via SearXNG with DuckDuckGo fallback.
 *
 * SearXNG URL resolution order:
 *   1. Constructor `searxngUrl` option
 *   2. `ctx.meta.searxngUrl` (per-call override)
 *   3. SEARXNG_URL environment variable
 *   4. http://localhost:8888 (default)
 */

import { BrowserService, browserService as defaultService } from "./browser-service.js";
import type { ToolDefinition, ToolExecutorResult } from "./types.js";
import { BaseTool, type ToolContext } from "./base-tool.js";

// ── Tool Definition ───────────────────────────────────────────────────────────

export const webSearchToolDefinition: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and return titles, URLs, and snippets. " +
    "Use this when you need current or external information not available in local context.",
  input_schema: {
    type: "object",
    properties: {
      q: { type: "string", description: "Search query" },
      query: { type: "string", description: "Backward-compatible alias for q" },
      count: { type: "number", description: "Number of results to return (1–10, default 5)" },
      country: { type: "string", description: "2-letter country code for regional results (e.g. 'US')" },
      freshness: { type: "string", description: "Filter by time: 'day', 'week', 'month', or 'year'" },
    },
    required: [],
  },
  tags: ["web", "search", "readonly"],
};

// ── Options ───────────────────────────────────────────────────────────────────

export interface WebSearchToolOptions {
  /**
   * SearXNG base URL for this tool instance.
   * Falls back to the module-level default (SEARXNG_URL env or localhost:8888).
   */
  searxngUrl?: string;
  /** Provide a pre-constructed BrowserService instance (e.g. for sharing). */
  browserService?: BrowserService;
}

// ── Class-based API ───────────────────────────────────────────────────────────

/** Fragment slot: rate / quota notes from metered web_search backends. */
export const WEB_SEARCH_RATE_SLOT = "web_search.rate-and-quota";

export class WebSearchTool extends BaseTool {
  readonly name = "web_search";
  readonly description = webSearchToolDefinition.description;
  readonly inputSchema = webSearchToolDefinition.input_schema as import("./base-tool.js").ToolInputSchema;
  readonly tags = ["web", "search", "readonly"] as const;

  describe(
    ctx: import("./prompt-context.js").PromptContextSnapshot,
    render: import("./prompt-context.js").RenderContext,
  ): string {
    const frags = ctx.fragments
      .filter((f) => f.slot === WEB_SEARCH_RATE_SLOT)
      .filter((f) => {
        if (!f.when) return true;
        try {
          return f.when(render, ctx);
        } catch {
          return false;
        }
      })
      .map((f) => f.content);
    if (frags.length === 0) return webSearchToolDefinition.description;
    return [
      webSearchToolDefinition.description,
      "",
      "Backend cost / rate notes:",
      ...frags.map((f) => "  - " + f),
    ].join("\n");
  }

  private readonly _browser: BrowserService;

  constructor(opts: WebSearchToolOptions = {}) {
    super();
    if (opts.browserService) {
      this._browser = opts.browserService;
    } else if (opts.searxngUrl) {
      this._browser = new BrowserService({ searxngUrl: opts.searxngUrl });
    } else {
      this._browser = defaultService;
    }
  }

  async run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutorResult> {
    const query = (params.q as string) ?? (params.query as string);
    if (!query || typeof query !== "string") throw new Error("q is required");

    const count = Math.min(Math.max(typeof params.count === "number" ? params.count : 5, 1), 10);
    const country = typeof params.country === "string" ? params.country : undefined;
    const timeRange = typeof params.freshness === "string" ? params.freshness : undefined;

    // Per-call URL override via context
    const metaUrl = ctx.meta?.searxngUrl as string | undefined;
    const browser = metaUrl ? new BrowserService({ searxngUrl: metaUrl }) : this._browser;

    const results = await browser.search(query, count, { country, timeRange });
    if (results.length === 0) return `No results found for: ${query}`;

    return results
      .map((r, i) => {
        const parts = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`];
        if (r.snippet) parts.push(`   ${r.snippet}`);
        return parts.join("\n");
      })
      .join("\n\n");
  }
}

// ── Functional API ────────────────────────────────────────────────────────────

export async function webSearchTool(
  params: Record<string, unknown>,
): Promise<ToolExecutorResult> {
  const tool = new WebSearchTool();
  return tool.run(params, { cwd: process.cwd() });
}
