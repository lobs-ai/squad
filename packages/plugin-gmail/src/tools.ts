import { google, type gmail_v1 } from "googleapis";
import { BaseTool, type ToolGroup } from "@squad/tools";
import type { ToolContext, ToolInputSchema } from "@squad/tools";
import { type GoogleAuthService } from "@squad/plugin-google-auth";
import { GMAIL_GUIDANCE } from "./prompt.js";

type AnyTool = BaseTool<Record<string, unknown>>;

function gmailFor(service: GoogleAuthService) {
  const authed = service.authedClientFor("gmail");
  if (!authed) {
    throw new Error(
      "no Google account with gmail enabled — connect one via /oauth/google/connect first",
    );
  }
  return {
    gmail: google.gmail({ version: "v1", auth: authed.client }),
    account: authed.account,
  };
}

interface SearchInput extends Record<string, unknown> {
  query: string;
  max?: number;
  include_spam_trash?: boolean;
}

export class GmailSearchTool extends BaseTool<SearchInput> {
  readonly name = "gmail_search";
  readonly description =
    "Search the user's Gmail using Gmail query syntax (e.g. 'from:alice subject:invoice newer_than:7d'). Returns thread/message ids and short snippets — use `gmail_read` to fetch the full message.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query" },
      max: { type: "number", description: "Max results, default 25" },
      include_spam_trash: { type: "boolean" },
    },
    required: ["query"],
  };
  readonly tags = ["readonly", "google", "gmail", "search"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: SearchInput, _ctx: ToolContext): Promise<string> {
    const { gmail } = gmailFor(this.service);
    const res = await gmail.users.messages.list({
      userId: "me",
      q: input.query,
      maxResults: input.max ?? 25,
      includeSpamTrash: input.include_spam_trash ?? false,
    });
    const messages = res.data.messages ?? [];
    if (messages.length === 0) return `No messages match: ${input.query}`;
    const lines = await Promise.all(
      messages.map(async (m) => {
        if (!m.id) return null;
        try {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          const headers = headersOf(detail.data);
          const subject = headers["Subject"] ?? "(no subject)";
          const from = headers["From"] ?? "?";
          const date = headers["Date"] ?? "";
          const snippet = (detail.data.snippet ?? "").slice(0, 120);
          return `- [${m.id}] ${date} — ${from}: ${subject}\n    ${snippet}`;
        } catch {
          return `- [${m.id}] (failed to fetch metadata)`;
        }
      }),
    );
    return lines.filter(Boolean).join("\n");
  }
}

interface ReadInput extends Record<string, unknown> {
  message_id: string;
  body_format?: "text" | "html" | "raw";
}

export class GmailReadTool extends BaseTool<ReadInput> {
  readonly name = "gmail_read";
  readonly description =
    "Fetch the full content of a Gmail message by id. Returns subject, from, to, date, and the text body. Set `body_format=html` to get the raw HTML part instead of the text part.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      message_id: { type: "string" },
      body_format: { type: "string", enum: ["text", "html", "raw"] },
    },
    required: ["message_id"],
  };
  readonly tags = ["readonly", "google", "gmail"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: ReadInput, _ctx: ToolContext): Promise<string> {
    const { gmail } = gmailFor(this.service);
    const res = await gmail.users.messages.get({
      userId: "me",
      id: input.message_id,
      format: input.body_format === "raw" ? "raw" : "full",
    });
    const headers = headersOf(res.data);
    const body =
      input.body_format === "raw"
        ? Buffer.from(res.data.raw ?? "", "base64").toString("utf8")
        : extractBody(res.data, input.body_format ?? "text");
    return [
      `Subject: ${headers["Subject"] ?? "(no subject)"}`,
      `From: ${headers["From"] ?? "?"}`,
      `To: ${headers["To"] ?? "?"}`,
      `Date: ${headers["Date"] ?? "?"}`,
      `Labels: ${(res.data.labelIds ?? []).join(", ")}`,
      "",
      body,
    ].join("\n");
  }
}

interface SendInput extends Record<string, unknown> {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to_message_id?: string;
}

export class GmailSendTool extends BaseTool<SendInput> {
  readonly name = "gmail_send";
  readonly description =
    "Send an email from the connected Gmail account. Use `reply_to_message_id` to thread the new message under an existing conversation. Body is plain text.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      to: { description: "Recipient email or array of emails" },
      subject: { type: "string" },
      body: { type: "string" },
      cc: { description: "CC email or array of emails" },
      bcc: { description: "BCC email or array of emails" },
      reply_to_message_id: {
        type: "string",
        description: "Optional message id to thread under (gmail_read returns the id you want).",
      },
    },
    required: ["to", "subject", "body"],
  };
  readonly tags = ["write", "google", "gmail"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: SendInput, _ctx: ToolContext): Promise<string> {
    const { gmail, account } = gmailFor(this.service);
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let referencedSubject: string | undefined;
    if (input.reply_to_message_id) {
      try {
        const original = await gmail.users.messages.get({
          userId: "me",
          id: input.reply_to_message_id,
          format: "metadata",
          metadataHeaders: ["Message-ID", "Subject"],
        });
        threadId = original.data.threadId ?? undefined;
        const headers = headersOf(original.data);
        inReplyTo = headers["Message-ID"];
        referencedSubject = headers["Subject"];
      } catch {
        // ignore — the send still goes through, just not threaded
      }
    }

    const subject = referencedSubject && !input.subject.startsWith("Re:")
      ? `Re: ${input.subject}`
      : input.subject;

    const raw = encodeRfc822({
      from: account.email,
      to: toArray(input.to),
      cc: input.cc ? toArray(input.cc) : undefined,
      bcc: input.bcc ? toArray(input.bcc) : undefined,
      subject,
      body: input.body,
      ...(inReplyTo ? { inReplyTo } : {}),
    });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, ...(threadId ? { threadId } : {}) },
    });
    return `Sent message ${res.data.id} (thread ${res.data.threadId ?? "—"}).`;
  }
}

interface ModifyLabelsInput extends Record<string, unknown> {
  message_id: string;
  add_labels?: string[];
  remove_labels?: string[];
}

export class GmailModifyLabelsTool extends BaseTool<ModifyLabelsInput> {
  readonly name = "gmail_modify_labels";
  readonly description =
    "Add and/or remove Gmail labels on a message. Built-in labels include INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM. Use `gmail_list_labels` to discover custom user labels.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      message_id: { type: "string" },
      add_labels: { type: "array", items: { type: "string" } },
      remove_labels: { type: "array", items: { type: "string" } },
    },
    required: ["message_id"],
  };
  readonly tags = ["write", "google", "gmail"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: ModifyLabelsInput, _ctx: ToolContext): Promise<string> {
    const { gmail } = gmailFor(this.service);
    await gmail.users.messages.modify({
      userId: "me",
      id: input.message_id,
      requestBody: {
        addLabelIds: input.add_labels ?? [],
        removeLabelIds: input.remove_labels ?? [],
      },
    });
    return `Updated labels on ${input.message_id}.`;
  }
}

export class GmailListLabelsTool extends BaseTool<Record<string, unknown>> {
  readonly name = "gmail_list_labels";
  readonly description =
    "List all Gmail labels (system + user-defined). Useful to find the id of a label you want to apply via `gmail_modify_labels`.";
  readonly inputSchema: ToolInputSchema = { type: "object", properties: {} };
  readonly tags = ["readonly", "google", "gmail"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(_input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    const { gmail } = gmailFor(this.service);
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels ?? [];
    if (labels.length === 0) return "(no labels)";
    return labels
      .map((l) => `- ${l.name} (id: ${l.id}, type: ${l.type ?? "user"})`)
      .join("\n");
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function headersOf(msg: gmail_v1.Schema$Message): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    if (h.name && h.value) out[h.name] = h.value;
  }
  return out;
}

function extractBody(msg: gmail_v1.Schema$Message, format: "text" | "html"): string {
  const target = format === "html" ? "text/html" : "text/plain";
  const body = walkParts(msg.payload, target);
  if (body) return body;
  // Fall back to whatever's on the top-level body.
  const fallback = msg.payload?.body?.data;
  return fallback ? Buffer.from(fallback, "base64url").toString("utf8") : "(no body)";
}

function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): string | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = walkParts(child, mimeType);
    if (found) return found;
  }
  return null;
}

function toArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

interface MessageSpec {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

export const gmailGroup: ToolGroup = {
  name: "gmail",
  description: "Search, read, send, and label email in the connected Gmail account.",
  toolNames: [
    "gmail_search",
    "gmail_read",
    "gmail_send",
    "gmail_modify_labels",
    "gmail_list_labels",
  ],
  guidance: GMAIL_GUIDANCE,
};

export function registerGmailTools(
  registry: { register(tool: AnyTool): unknown },
  service: GoogleAuthService,
): void {
  registry.register(new GmailSearchTool(service) as unknown as AnyTool);
  registry.register(new GmailReadTool(service) as unknown as AnyTool);
  registry.register(new GmailSendTool(service) as unknown as AnyTool);
  registry.register(new GmailModifyLabelsTool(service) as unknown as AnyTool);
  registry.register(new GmailListLabelsTool(service) as unknown as AnyTool);
}

function encodeRfc822(spec: MessageSpec): string {
  const lines: string[] = [
    `From: ${spec.from}`,
    `To: ${spec.to.join(", ")}`,
  ];
  if (spec.cc && spec.cc.length > 0) lines.push(`Cc: ${spec.cc.join(", ")}`);
  if (spec.bcc && spec.bcc.length > 0) lines.push(`Bcc: ${spec.bcc.join(", ")}`);
  if (spec.inReplyTo) {
    lines.push(`In-Reply-To: ${spec.inReplyTo}`);
    lines.push(`References: ${spec.inReplyTo}`);
  }
  lines.push(`Subject: ${spec.subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(spec.body);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
