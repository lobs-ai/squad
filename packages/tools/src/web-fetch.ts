/**
 * WebFetchTool — fetch readable content from any URL via Playwright.
 *
 * Playwright launches a headless Chromium browser that:
 * - Executes JavaScript (handles SPAs, dynamic content)
 * - Waits for content to render before extracting
 * - Strips nav, ads, and boilerplate before returning text
 *
 * The browser instance is shared with WebSearchTool and is lazy-launched
 * (only started when the first fetch is made).
 */

import { BrowserService, browserService as defaultService } from "./browser-service.js";
import type { ToolDefinition, ToolExecutorResult } from "./types.js";
import { BaseTool, type ToolContext } from "./base-tool.js";

// ── Tool Definition ───────────────────────────────────────────────────────────

export const webFetchToolDefinition: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch and extract readable content from a URL, including JS-rendered pages. " +
    "Use this to read articles, documentation, or specific pages when you already know the URL.",
  input_schema: {
    type: "object",
    properties: {
      href: { type: "string", description: "HTTP or HTTPS URL to fetch" },
      url: { type: "string", description: "Backward-compatible alias for href" },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 50000)",
      },
    },
    required: [],
  },
  tags: ["web", "fetch", "readonly"],
};

// ── Options ───────────────────────────────────────────────────────────────────

export interface WebFetchToolOptions {
  /** Provide a pre-constructed BrowserService instance (e.g. for sharing). */
  browserService?: BrowserService;
}

// ── Class-based API ───────────────────────────────────────────────────────────

export class WebFetchTool extends BaseTool {
  readonly name = "web_fetch";
  readonly description = webFetchToolDefinition.description;
  readonly inputSchema = webFetchToolDefinition.input_schema as import("./base-tool.js").ToolInputSchema;
  readonly tags = ["web", "fetch", "readonly"] as const;

  private readonly _browser: BrowserService;

  constructor(opts: WebFetchToolOptions = {}) {
    super();
    this._browser = opts.browserService ?? defaultService;
  }

  async run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const url = (params.href as string) ?? (params.url as string);
    if (!url || typeof url !== "string") throw new Error("href is required");

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("Only HTTP")) throw e;
      throw new Error(`Invalid URL: ${url}`);
    }

    const maxChars = typeof params.maxChars === "number" ? params.maxChars : 50_000;

    try {
      const result = await this._browser.fetch(url, maxChars);
      const parts: string[] = [];
      if (result.title) parts.push(`Title: ${result.title}`);
      parts.push(`URL: ${result.url}`, `Length: ${result.content.length} chars`, "", result.content);
      return parts.join("\n");
    } catch (err) {
      return `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── Functional API ────────────────────────────────────────────────────────────

export async function webFetchTool(
  params: Record<string, unknown>,
): Promise<ToolExecutorResult> {
  const tool = new WebFetchTool();
  return tool.run(params, { cwd: process.cwd() });
}
