import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveEnv, httpBase } from "../env.js";
import { getLastSessionId } from "../session-store.js";
import { ProtocolClient } from "../protocol-client.js";
import * as render from "../render.js";
import { C, color, fg } from "../ui/colors.js";
import { roleColor } from "../ui/skin.js";
import { printCompactHeader } from "../ui/banner.js";

/**
 * Hit /health using node's raw http module — bypasses fetch+undici, which
 * silently routes through HTTP_PROXY / HTTPS_PROXY and would let a corporate
 * proxy intercept localhost requests and answer 502.
 */
function ping(url: string, timeoutMs: number): Promise<{ ok: boolean; body: string; statusCode: number }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
          resolve({ ok, body, statusCode: res.statusCode ?? 0 });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: "", statusCode: 0 });
    });
    req.on("error", () => resolve({ ok: false, body: "", statusCode: 0 }));
    req.end();
  });
}

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export async function showStatus(): Promise<void> {
  let env;
  try {
    env = resolveEnv();
  } catch (err) {
    render.renderError(`not configured: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const base = httpBase(env.url);
  const { ok: healthOk } = await ping(`${base}/health`, 2000);

  const muted = fg(roleColor("muted"));
  const ok = fg(roleColor("ok"));
  const errColor = fg(roleColor("err"));

  printCompactHeader();
  process.stdout.write("\n");

  // ── network reachability ────────────────────────────────────────────────
  const reachableLabel = healthOk
    ? color("reachable", ok)
    : color("unreachable", errColor);
  render.renderKeyValue([
    ["gateway  ", `${env.url} ${color("·", muted)} ${reachableLabel}`],
  ]);

  if (!healthOk) {
    render.renderInfo(`${muted}  try: squad start${C.RESET}`);
    process.exitCode = 1;
    return;
  }

  // ── deep WS-level details ───────────────────────────────────────────────
  const client = new ProtocolClient({ url: env.url, token: env.token });
  try {
    await client.connect();
  } catch (e) {
    render.renderError(`/health responded but WS auth failed: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const [health, config, sessions, models] = await Promise.all([
      client.request("admin.health", {}),
      client.request("admin.config", {}),
      client.request("session.list", { limit: 200 }),
      client.request("admin.models", {}).catch(() => ({ models: [] })),
    ]);

    // Optional WS methods — swallow failures so status works against a
    // minimal gateway configuration.
    const [plugins, channels] = await Promise.all([
      client.request("plugins.list", {}).catch(() => ({ plugins: [] })),
      client.request("channels.list", {}).catch(() => ({ channels: [] })),
    ]);

    render.renderKeyValue([
      ["version  ", health.version],
      ["uptime   ", formatUptime(health.uptimeSeconds)],
      ["sessions ", `${health.sessions.active} active ${color("/", muted)} ${health.sessions.total} total`],
    ]);

    render.renderHeader("Models");
    render.renderKeyValue([
      ["primary  ", config.primary.model],
      ["fallback ", config.fallbacks.map((f) => f.model).join(", ") || color("(none)", muted)],
      ["providers", config.providers.join(", ") || color("(none wired)", muted)],
      ["catalogue", `${models.models.length} models available`],
    ]);

    if (plugins.plugins.length > 0) {
      render.renderHeader("Plugins");
      for (const p of plugins.plugins) {
        const enabledMark = p.enabled ? color("●", ok) : color("○", muted);
        process.stdout.write(
          `  ${enabledMark} ${p.name} ${color(`v${p.version}`, muted)} ${color(`(${p.kinds.join(", ")})`, muted)}\n`,
        );
      }
    }

    if (channels.channels.length > 0) {
      render.renderHeader("Channels");
      for (const c of channels.channels) {
        const connected = c.connected ? color("● connected", ok) : color("○ offline", muted);
        process.stdout.write(`  ${c.kind.padEnd(10)} ${color(c.label, muted)}  ${connected}\n`);
      }
    }

    render.renderHeader("Subagents");
    render.renderKeyValue([
      ["max global   ", String(config.subagents.maxConcurrentGlobal)],
      ["max per-parent", String(config.subagents.maxConcurrentPerParent)],
      ["max depth    ", String(config.subagents.maxTreeDepth)],
    ]);

    // ── current session ─────────────────────────────────────────────────
    const sid = getLastSessionId();
    if (sid) {
      const current = sessions.sessions.find((s) => s.id === sid);
      if (current) {
        render.renderHeader("Current session");
        render.renderKeyValue([
          ["id      ", current.id],
          ["title   ", current.title ?? color("(untitled)", muted)],
          ["status  ", current.status],
          ["model   ", current.model],
          ["tokens  ", `${current.tokensIn.toLocaleString()} in · ${current.tokensOut.toLocaleString()} out`],
        ]);
      } else {
        render.renderInfo(`last session ${sid} is no longer known to the gateway`);
      }
    }

    process.stdout.write("\n");
  } finally {
    client.close();
  }
}
