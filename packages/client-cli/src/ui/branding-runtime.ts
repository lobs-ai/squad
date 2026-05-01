/**
 * Pull display labels from the gateway's `admin.identity` and apply them as
 * skin branding overrides. Called after `client.connect()` by every CLI
 * entry point that prints branded text (REPL, chat, status), so a single
 * `branding` block in the gateway config rebrands the dashboard *and* CLI
 * in lock-step.
 *
 * Best-effort: an older gateway without a `branding` field, or a transient
 * RPC failure, just leaves the active skin's branding intact.
 */

import type { ProtocolClient } from "../protocol-client.js";
import { setBrandingOverrides } from "./skin.js";

export async function loadGatewayBranding(client: ProtocolClient): Promise<void> {
  try {
    const identity = await client.request("admin.identity", {});
    const b = (identity as { branding?: { agentName?: string; userName?: string } }).branding;
    if (!b) return;
    setBrandingOverrides({
      ...(b.agentName ? { agent_name: b.agentName } : {}),
      ...(b.userName ? { user_name: b.userName } : {}),
    });
  } catch {
    // older gateway or transient error — keep skin branding as-is
  }
}
