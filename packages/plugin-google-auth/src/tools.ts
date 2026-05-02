import { BaseTool, type ToolGroup } from "@squad/tools";
import type { ToolContext, ToolInputSchema } from "@squad/tools";
import type { GoogleAuthService } from "./service.js";
import { GOOGLE_AUTH_GUIDANCE } from "./prompt.js";

type AnyTool = BaseTool<Record<string, unknown>>;

type ListAccountsInput = Record<string, unknown>;

export class GoogleListAccountsTool extends BaseTool<ListAccountsInput> {
  readonly name = "google_list_accounts";
  readonly description =
    "List Google accounts connected to this gateway, with the email and which features (calendar/gmail/drive) each account has enabled. Use to confirm whether the user has a Google account connected before calling Google tools.";
  readonly inputSchema: ToolInputSchema = { type: "object", properties: {} };
  readonly tags = ["readonly", "google"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(_input: ListAccountsInput, _ctx: ToolContext): Promise<string> {
    const accounts = this.service.listAccounts();
    if (accounts.length === 0) return "No Google accounts connected.";
    const lines = accounts.map(
      (a) => `- ${a.email} (id: ${a.id}, features: ${a.features.join(", ")})`,
    );
    return ["Connected Google accounts:", ...lines].join("\n");
  }
}

type ConnectUrlInput = Record<string, unknown>;

export class GoogleConnectUrlTool extends BaseTool<ConnectUrlInput> {
  readonly name = "google_connect_url";
  readonly description =
    "Return a URL the user can open in their browser to connect (or reconnect) a Google account. Hand this URL to the user — do NOT try to follow it from the agent.";
  readonly inputSchema: ToolInputSchema = { type: "object", properties: {} };
  readonly tags = ["readonly", "google"] as const;

  constructor(
    private readonly service: GoogleAuthService,
    private readonly baseUrl: string,
  ) {
    super();
  }

  async run(_input: ConnectUrlInput, _ctx: ToolContext): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/oauth/google/connect`;
    return `Open this URL in a browser to connect a Google account:\n${url}\n\nIt will redirect to Google's consent screen, then back here when you approve.`;
  }
}

interface DisconnectInput extends Record<string, unknown> {
  account_id: string;
}

export class GoogleDisconnectTool extends BaseTool<DisconnectInput> {
  readonly name = "google_disconnect_account";
  readonly description =
    "Disconnect a Google account, revoking its tokens and removing it from the gateway. Use the account id from `google_list_accounts`.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      account_id: { type: "string", description: "Account id (e.g. ga_abc123)" },
    },
    required: ["account_id"],
  };
  readonly tags = ["write", "google"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: DisconnectInput, _ctx: ToolContext): Promise<string> {
    await this.service.disconnect(input.account_id);
    return `Disconnected ${input.account_id}.`;
  }
}

/**
 * Lazy-loaded tool group exposed by the plugin. Mirrors the discord plugin's
 * `discordGroup` shape — visible in the system-prompt index, fully described
 * via `describe_tool_group`.
 */
export const googleAuthGroup: ToolGroup = {
  name: "google_auth",
  description:
    "Manage Google account connections — list, get connect URL, disconnect. Gateway entry point for the calendar/gmail/drive groups.",
  toolNames: ["google_list_accounts", "google_connect_url", "google_disconnect_account"],
  guidance: GOOGLE_AUTH_GUIDANCE,
};

/**
 * Construct + register every tool in the google_auth group against a tool
 * registry. Mirrors `registerDiscordTools` so plugin authors can reuse the
 * same idiom.
 */
export function registerGoogleAuthTools(
  registry: { register(tool: AnyTool): unknown },
  service: GoogleAuthService,
  baseUrl: string,
): void {
  registry.register(new GoogleListAccountsTool(service) as unknown as AnyTool);
  registry.register(new GoogleConnectUrlTool(service, baseUrl) as unknown as AnyTool);
  registry.register(new GoogleDisconnectTool(service) as unknown as AnyTool);
}
