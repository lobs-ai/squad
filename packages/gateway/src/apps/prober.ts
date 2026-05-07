import { request as httpRequest } from "node:http";
import type { AppHealth } from "@squad/protocol";
import type { AppRegistry } from "./registry.js";
import type { Logger } from "../logger.js";

export interface AppProberOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

const DEFAULT_INTERVAL = 10_000;
const DEFAULT_TIMEOUT = 2_000;

/**
 * Periodically hits `GET /squad/health` on every registered app and feeds
 * the result back into the registry. Apps that don't respond within the
 * timeout flip to `unhealthy`; apps that respond with a 2xx flip to
 * `healthy`. The first probe of a freshly registered app moves it out of
 * `unknown`.
 *
 * Also tries `GET /squad/info` once per healthy app to populate metadata
 * the agent didn't include at registration time.
 */
export class AppProber {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly registry: AppRegistry,
    private readonly logger: Logger,
    opts: AppProberOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), this.intervalMs);
    // Don't keep the process alive for probing alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const apps = this.registry.list();
    await Promise.all(
      apps.map(async (app) => {
        const health = await probe(app.host, app.port, "/squad/health", this.timeoutMs);
        let info: Record<string, unknown> | null = null;
        if (health === "healthy" && app.info === null) {
          info = await fetchInfo(app.host, app.port, this.timeoutMs).catch(() => null);
        }
        this.registry.setHealth(app.name, health, info);
      }),
    );
  }
}

function probe(host: string, port: number, path: string, timeoutMs: number): Promise<AppHealth> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path, method: "GET", timeout: timeoutMs }, (res) => {
      // Drain to free the socket regardless of body content.
      res.resume();
      const ok = (res.statusCode ?? 500) < 400;
      resolve(ok ? "healthy" : "unhealthy");
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("unhealthy");
    });
    req.on("error", () => resolve("unhealthy"));
    req.end();
  });
}

function fetchInfo(host: string, port: number, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host, port, path: "/squad/info", method: "GET", timeout: timeoutMs },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed && typeof parsed === "object" ? parsed : null);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}
