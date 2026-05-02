import { google } from "googleapis";
import { BaseTool, type ToolGroup } from "@squad/tools";
import type { ToolContext, ToolInputSchema } from "@squad/tools";
import { type GoogleAuthService } from "@squad/plugin-google-auth";
import { GOOGLE_DRIVE_GUIDANCE } from "./prompt.js";

type AnyTool = BaseTool<Record<string, unknown>>;

function driveFor(service: GoogleAuthService) {
  const authed = service.authedClientFor("drive");
  if (!authed) {
    throw new Error(
      "no Google account with drive enabled — connect one via /oauth/google/connect first",
    );
  }
  return {
    drive: google.drive({ version: "v3", auth: authed.client }),
    account: authed.account,
  };
}

interface SearchInput extends Record<string, unknown> {
  query: string;
  max?: number;
  include_trashed?: boolean;
}

export class DriveSearchTool extends BaseTool<SearchInput> {
  readonly name = "google_drive_search";
  readonly description =
    "Search Google Drive using Drive query syntax (e.g. \"name contains 'budget' and mimeType = 'application/pdf'\"). Returns id, name, mimeType, and modified date — pass id to `google_drive_read` for content.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "Drive query string" },
      max: { type: "number", description: "Max results, default 25" },
      include_trashed: { type: "boolean" },
    },
    required: ["query"],
  };
  readonly tags = ["readonly", "google", "drive", "search"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: SearchInput, _ctx: ToolContext): Promise<string> {
    const { drive } = driveFor(this.service);
    const q = input.include_trashed ? input.query : `(${input.query}) and trashed = false`;
    const res = await drive.files.list({
      q,
      fields: "files(id, name, mimeType, modifiedTime, owners(emailAddress), webViewLink, size)",
      pageSize: input.max ?? 25,
      orderBy: "modifiedTime desc",
    });
    const files = res.data.files ?? [];
    if (files.length === 0) return `No files match: ${input.query}`;
    return files
      .map((f) => {
        const owner = f.owners?.[0]?.emailAddress ?? "?";
        const sz = f.size ? `${f.size}B` : "—";
        return `- ${f.name} [${f.mimeType}] (id: ${f.id}, owner: ${owner}, modified: ${f.modifiedTime}, size: ${sz})`;
      })
      .join("\n");
  }
}

interface ListInput extends Record<string, unknown> {
  folder_id?: string;
  max?: number;
}

export class DriveListTool extends BaseTool<ListInput> {
  readonly name = "google_drive_list_files";
  readonly description =
    "List the contents of a Drive folder by id, or the root folder when `folder_id` is omitted. Use `google_drive_search` for keyword lookups.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      folder_id: { type: "string", description: "Folder id; defaults to 'root'." },
      max: { type: "number", description: "Max results, default 50" },
    },
  };
  readonly tags = ["readonly", "google", "drive"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: ListInput, _ctx: ToolContext): Promise<string> {
    const { drive } = driveFor(this.service);
    const parent = input.folder_id ?? "root";
    const res = await drive.files.list({
      q: `'${parent}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, modifiedTime, size)",
      pageSize: input.max ?? 50,
      orderBy: "folder, name",
    });
    const files = res.data.files ?? [];
    if (files.length === 0) return "(empty folder)";
    return files
      .map((f) => {
        const kind = f.mimeType === "application/vnd.google-apps.folder" ? "[dir]" : "[file]";
        return `- ${kind} ${f.name} (id: ${f.id}, mime: ${f.mimeType}, modified: ${f.modifiedTime})`;
      })
      .join("\n");
  }
}

interface ReadInput extends Record<string, unknown> {
  file_id: string;
  max_bytes?: number;
}

const GOOGLE_DOC_EXPORTS: Record<string, { mime: string; label: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", label: "Doc → text" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", label: "Sheet → CSV" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", label: "Slides → text" },
};

export class DriveReadTool extends BaseTool<ReadInput> {
  readonly name = "google_drive_read";
  readonly description =
    "Fetch the contents of a Drive file by id. Google Docs / Sheets / Slides are exported to text/CSV; everything else is downloaded as-is. `max_bytes` caps the returned body (default 64KB).";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      file_id: { type: "string" },
      max_bytes: { type: "number", description: "Truncate body to this many bytes (default 65536)" },
    },
    required: ["file_id"],
  };
  readonly tags = ["readonly", "google", "drive"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: ReadInput, _ctx: ToolContext): Promise<string> {
    const { drive } = driveFor(this.service);
    const meta = await drive.files.get({
      fileId: input.file_id,
      fields: "id, name, mimeType, size",
    });
    const { name, mimeType } = meta.data;
    const cap = input.max_bytes ?? 64 * 1024;

    const exporter = mimeType ? GOOGLE_DOC_EXPORTS[mimeType] : undefined;
    let body: string;
    let exportedAs: string | null = null;
    if (exporter) {
      const res = await drive.files.export(
        { fileId: input.file_id, mimeType: exporter.mime },
        { responseType: "text" },
      );
      body = String(res.data ?? "");
      exportedAs = exporter.label;
    } else {
      const res = await drive.files.get(
        { fileId: input.file_id, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const buf = Buffer.from(res.data as ArrayBuffer);
      body = isProbablyText(buf, mimeType ?? "")
        ? buf.toString("utf8")
        : `(binary content, ${buf.length} bytes — base64 truncated below)\n${buf.toString("base64").slice(0, cap)}`;
    }
    if (body.length > cap) {
      body = `${body.slice(0, cap)}\n…[truncated at ${cap} bytes]`;
    }
    const header = [
      `Name: ${name}`,
      `Mime: ${mimeType}`,
      exportedAs ? `Exported: ${exportedAs}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    return `${header}\n\n${body}`;
  }
}

export const googleDriveGroup: ToolGroup = {
  name: "google_drive",
  description: "Search, list, and read Google Drive files on the connected account.",
  toolNames: ["google_drive_search", "google_drive_list_files", "google_drive_read"],
  guidance: GOOGLE_DRIVE_GUIDANCE,
};

export function registerGoogleDriveTools(
  registry: { register(tool: AnyTool): unknown },
  service: GoogleAuthService,
): void {
  registry.register(new DriveSearchTool(service) as unknown as AnyTool);
  registry.register(new DriveListTool(service) as unknown as AnyTool);
  registry.register(new DriveReadTool(service) as unknown as AnyTool);
}

function isProbablyText(buf: Buffer, mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/xml") return true;
  // Heuristic: short file with no NULs is likely text.
  if (buf.length < 1024 * 1024) {
    for (let i = 0; i < Math.min(buf.length, 1024); i++) {
      if (buf[i] === 0) return false;
    }
    return true;
  }
  return false;
}
