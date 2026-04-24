/**
 * BrowserService — shared Playwright instance + SearXNG search.
 *
 * Search: local SearXNG (no CAPTCHAs, aggregates many engines)
 *         with DuckDuckGo HTML as an automatic fallback.
 * Fetch:  Playwright headless Chromium for JS-rendered pages.
 *
 * The default exported `browserService` is a lazy singleton; you can
 * also construct your own instance with a custom SearXNG URL.
 *
 * Auto-setup SearXNG:
 *   import { setupSearXNG } from "@agentic/tools/browser-service";
 *   await setupSearXNG(); // checks if running, starts Docker if not
 */

import type { Browser, BrowserContext } from "playwright";
import { spawn } from "node:child_process";

/**
 * Lazily import `playwright` so bundlers / consumers that don't use the browser
 * tool never need it installed. Throws with a helpful message if it's missing.
 */
async function loadChromium() {
  try {
    const mod = await import("playwright");
    return mod.chromium;
  } catch (err) {
    throw new Error(
      `The browser tool requires the "playwright" peer dependency. Install it with: npm install playwright`,
      { cause: err },
    );
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchResult {
  title: string;
  url: string;
  content: string;
}

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

export interface BrowserServiceOptions {
  /** SearXNG base URL. Defaults to SEARXNG_URL env var or http://localhost:8888. */
  searxngUrl?: string;
}

// ── BrowserService ────────────────────────────────────────────────────────────

export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;
  readonly searxngUrl: string;

  constructor(opts: BrowserServiceOptions = {}) {
    this.searxngUrl = opts.searxngUrl ?? process.env.SEARXNG_URL ?? "http://localhost:8888";
  }

  /** Lazy-launch Playwright (only needed for fetch + DDG fallback). */
  async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) {
      await this.launching;
      return this.context!;
    }
    this.launching = this._launch().catch((err) => {
      this.launching = null;
      throw err;
    });
    await this.launching;
    return this.context!;
  }

  private async _launch(): Promise<void> {
    const chromium = await loadChromium();
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
  }

  /**
   * Search via local SearXNG.
   * Falls back to DuckDuckGo HTML scraping if SearXNG is unreachable.
   */
  async search(
    query: string,
    count = 5,
    opts: { language?: string; country?: string; timeRange?: string } = {},
  ): Promise<SearchResult[]> {
    try {
      const params = new URLSearchParams({ q: query, format: "json", language: opts.language ?? "en" });
      if (opts.timeRange) params.set("time_range", opts.timeRange);
      if (opts.country) params.set("country", opts.country);

      const res = await fetch(`${this.searxngUrl}/search?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`SearXNG ${res.status}: ${res.statusText}`);

      const data = (await res.json()) as SearXNGResponse;
      return data.results.slice(0, count).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      }));
    } catch {
      return this.searchDDGFallback(query, count);
    }
  }

  private async searchDDGFallback(query: string, count: number): Promise<SearchResult[]> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      const raw = await page.evaluate((max: number) => {
        return Array.from(document.querySelectorAll(".result"))
          .slice(0, max)
          .map((el) => {
            const a = el.querySelector(".result__title a, .result__a");
            const s = el.querySelector(".result__snippet");
            return {
              title: a?.textContent?.trim() ?? "",
              url: a?.getAttribute("href") ?? "",
              snippet: s?.textContent?.trim() ?? "",
            };
          })
          .filter((r) => r.title && r.url);
      }, count);

      return raw.map((r) => ({
        ...r,
        url: r.url.startsWith("//duckduckgo.com/l/")
          ? decodeURIComponent(new URL("https:" + r.url).searchParams.get("uddg") ?? r.url)
          : r.url,
      }));
    } finally {
      await page.close();
    }
  }

  /** Fetch a URL and extract readable text content via Playwright. */
  async fetch(url: string, maxChars = 50_000): Promise<FetchResult> {
    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForTimeout(1_500); // JS rendering

      const data = await page.evaluate(() => {
        for (const sel of [
          "script", "style", "nav", "footer", "header", "aside",
          ".sidebar", ".nav", ".footer", ".header", ".ad", ".advertisement",
          "[role='banner']", "[role='navigation']", ".cookie-banner", ".popup",
        ]) {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        }
        const main =
          document.querySelector("main, article, .content, .post, #content, #main, [role='main']") ??
          document.body;
        return {
          title: document.title,
          text: (main as HTMLElement).innerText ?? main.textContent ?? "",
          url: window.location.href,
        };
      });

      return { title: data.title, url: data.url, content: data.text.slice(0, maxChars) };
    } finally {
      await page.close();
    }
  }

  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.launching = null;
    }
  }
}

/** Module-level singleton — URL is read from SEARXNG_URL env var at import time. */
export const browserService = new BrowserService();

// ── SearXNG auto-setup ────────────────────────────────────────────────────────

/**
 * Check if SearXNG is reachable; if not, start it via Docker.
 *
 * @param url   SearXNG base URL (defaults to http://localhost:8888)
 * @param port  Host port to map (defaults to 8888)
 *
 * @example
 * ```ts
 * await setupSearXNG(); // start before your agent run
 * ```
 */
export async function setupSearXNG(url = "http://localhost:8888", port = 8888): Promise<void> {
  // Check if already reachable
  try {
    const res = await fetch(`${url}/search?q=test&format=json`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) return;
  } catch {
    // fall through to docker start
  }

  // Try starting an existing stopped container first
  await new Promise<void>((resolve) => {
    const proc = spawn("docker", ["start", "searxng"]);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else resolve(); // ignore — will try docker run next
    });
    proc.on("error", () => resolve());
  });

  // Check again after starting existing container
  try {
    const res = await fetch(`${url}/search?q=test&format=json`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) return;
  } catch {
    // fall through to docker run
  }

  // Create and start a new container
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("docker", [
      "run", "-d",
      "--name", "searxng",
      "-p", `${port}:8080`,
      "--restart", "unless-stopped",
      "searxng/searxng:latest",
    ]);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker run exited ${code}`))));
    proc.on("error", reject);
  });

  // Wait for readiness (up to 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const res = await fetch(`${url}/search?q=test&format=json`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
    } catch {
      // still starting
    }
  }
  throw new Error("SearXNG did not become ready within 30 seconds");
}
