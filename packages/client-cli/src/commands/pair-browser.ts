import { resolveEnv } from "../env.js";
import { ProtocolClient } from "../protocol-client.js";
import * as render from "../render.js";
import { C, color, fg } from "../ui/colors.js";
import { roleColor } from "../ui/skin.js";
import type { PairingView } from "@squad/protocol";

function fmtAge(iso: string): string {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function expiresIn(iso: string): string {
  const s = Math.floor((Date.parse(iso) - Date.now()) / 1000);
  if (s < 0) return "expired";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

async function withClient<T>(fn: (client: ProtocolClient) => Promise<T>): Promise<T> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * `squad pair browser <code>` — approve a pending browser pairing. Mints a
 * runtime token for the browser; the dashboard's gate has been polling and
 * will pick it up within ~1s.
 */
export async function runPairBrowserApprove(code: string | undefined): Promise<void> {
  if (!code) {
    throw new Error("usage: squad pair browser <code>   (the code is shown in the dashboard's pairing screen)");
  }
  const muted = fg(roleColor("muted"));
  const ok = fg(roleColor("ok"));
  await withClient(async (client) => {
    const { pairing } = await client.request("admin.pair.approve", { code });
    process.stdout.write(
      `${color("●", ok)} approved ${color(pairing.code, ok)} ${color("·", muted)} ${pairing.label}\n`,
    );
    process.stdout.write(
      `  the dashboard should connect within a second.${C.RESET}\n`,
    );
  });
}

/**
 * `squad pair browser list` — show pending/approved pairings.
 */
export async function runPairBrowserList(): Promise<void> {
  const muted = fg(roleColor("muted"));
  const ok = fg(roleColor("ok"));
  const accent = fg(roleColor("accent"));
  await withClient(async (client) => {
    const { pairings } = await client.request("admin.pair.list", {});
    if (pairings.length === 0) {
      render.renderInfo("no pending browser pairings.");
      return;
    }
    for (const p of pairings as PairingView[]) {
      const dot =
        p.status === "approved" ? color("●", ok)
          : p.status === "pending" ? color("◐", accent)
            : color("○", muted);
      process.stdout.write(
        `  ${dot} ${color(p.code, accent)} ${color("·", muted)} ${p.label} ` +
          `${color("·", muted)} ${p.status} ${color("·", muted)} ${color(`(expires in ${expiresIn(p.expiresAt)}, ${fmtAge(p.createdAt)})`, muted)}\n`,
      );
    }
  });
}

/**
 * `squad pair browser cancel <code>` — revoke a pending pairing (and any
 * runtime token it issued).
 */
export async function runPairBrowserCancel(code: string | undefined): Promise<void> {
  if (!code) {
    throw new Error("usage: squad pair browser cancel <code>");
  }
  await withClient(async (client) => {
    const { pairing } = await client.request("admin.pair.cancel", { code });
    render.renderInfo(`cancelled ${pairing.code}`);
  });
}
