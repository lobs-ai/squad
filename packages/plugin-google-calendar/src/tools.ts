import { google } from "googleapis";
import { BaseTool, type ToolGroup } from "@squad/tools";
import type { ToolContext, ToolInputSchema } from "@squad/tools";
import { type GoogleAuthService } from "@squad/plugin-google-auth";
import { GOOGLE_CALENDAR_GUIDANCE } from "./prompt.js";

type AnyTool = BaseTool<Record<string, unknown>>;

function calendarFor(service: GoogleAuthService) {
  const authed = service.authedClientFor("calendar");
  if (!authed) {
    throw new Error(
      "no Google account with calendar enabled — connect one via /oauth/google/connect first",
    );
  }
  return { cal: google.calendar({ version: "v3", auth: authed.client }), account: authed.account };
}

type ListCalendarsInput = Record<string, unknown>;

export class ListCalendarsTool extends BaseTool<ListCalendarsInput> {
  readonly name = "google_calendar_list_calendars";
  readonly description =
    "List the user's Google calendars (id, summary, primary flag). Use this to discover the calendar id for create/update/list-events calls — `primary` always works as an alias for the user's main calendar.";
  readonly inputSchema: ToolInputSchema = { type: "object", properties: {} };
  readonly tags = ["readonly", "google", "calendar"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(_input: ListCalendarsInput, _ctx: ToolContext): Promise<string> {
    const { cal } = calendarFor(this.service);
    const res = await cal.calendarList.list({ maxResults: 100 });
    const items = res.data.items ?? [];
    if (items.length === 0) return "No calendars found.";
    const lines = items.map((c) => {
      const flags = [c.primary ? "primary" : null, c.accessRole ? `role=${c.accessRole}` : null]
        .filter(Boolean)
        .join(", ");
      return `- ${c.summary ?? "(untitled)"} — id: ${c.id} ${flags ? `[${flags}]` : ""}`.trim();
    });
    return lines.join("\n");
  }
}

interface ListEventsInput extends Record<string, unknown> {
  calendar_id?: string;
  from?: string;
  to?: string;
  max?: number;
  query?: string;
}

export class ListEventsTool extends BaseTool<ListEventsInput> {
  readonly name = "google_calendar_list_events";
  readonly description =
    "List events on a Google calendar within a time range. Defaults to the next 7 days on the primary calendar. `from` and `to` accept ISO-8601 datetimes; `query` does free-text search.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "Calendar id; defaults to 'primary'" },
      from: {
        type: "string",
        description: "ISO-8601 lower bound (inclusive). Default: now.",
      },
      to: {
        type: "string",
        description: "ISO-8601 upper bound (exclusive). Default: from + 7 days.",
      },
      max: { type: "number", description: "Max results, default 50" },
      query: { type: "string", description: "Free-text search across summary/description/location" },
    },
  };
  readonly tags = ["readonly", "google", "calendar"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: ListEventsInput, _ctx: ToolContext): Promise<string> {
    const { cal } = calendarFor(this.service);
    const from = input.from ? new Date(input.from) : new Date();
    const to = input.to
      ? new Date(input.to)
      : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    const res = await cal.events.list({
      calendarId: input.calendar_id ?? "primary",
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: input.max ?? 50,
      ...(input.query ? { q: input.query } : {}),
    });
    const items = res.data.items ?? [];
    if (items.length === 0) return "(no events in range)";
    const lines = items.map((e) => {
      const start = e.start?.dateTime ?? e.start?.date ?? "?";
      const end = e.end?.dateTime ?? e.end?.date ?? "?";
      const title = e.summary ?? "(no title)";
      const loc = e.location ? ` @ ${e.location}` : "";
      const status = e.status && e.status !== "confirmed" ? ` [${e.status}]` : "";
      return `- ${start} → ${end} — ${title}${loc}${status} (id: ${e.id})`;
    });
    return lines.join("\n");
  }
}

interface CreateEventInput extends Record<string, unknown> {
  calendar_id?: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  attendees?: string[];
  send_updates?: "all" | "externalOnly" | "none";
}

export class CreateEventTool extends BaseTool<CreateEventInput> {
  readonly name = "google_calendar_create_event";
  readonly description =
    "Create a Google Calendar event. `start` and `end` are ISO-8601 datetimes (timed) or YYYY-MM-DD strings (all-day). Attendees are optional emails — set `send_updates=all` to email them.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "Calendar id; defaults to 'primary'" },
      title: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "string", description: "ISO-8601 datetime or YYYY-MM-DD for all-day" },
      end: { type: "string", description: "ISO-8601 datetime or YYYY-MM-DD for all-day" },
      attendees: { type: "array", items: { type: "string" } },
      send_updates: { type: "string", enum: ["all", "externalOnly", "none"] },
    },
    required: ["title", "start", "end"],
  };
  readonly tags = ["write", "google", "calendar"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: CreateEventInput, _ctx: ToolContext): Promise<string> {
    const { cal } = calendarFor(this.service);
    const allDay = isYmd(input.start) && isYmd(input.end);
    const requestBody = {
      summary: input.title,
      description: input.description,
      location: input.location,
      start: allDay ? { date: input.start } : { dateTime: new Date(input.start).toISOString() },
      end: allDay ? { date: input.end } : { dateTime: new Date(input.end).toISOString() },
      ...(input.attendees && input.attendees.length > 0
        ? { attendees: input.attendees.map((email) => ({ email })) }
        : {}),
    };
    const res = await cal.events.insert({
      calendarId: input.calendar_id ?? "primary",
      requestBody,
      sendUpdates: input.send_updates ?? "none",
    });
    return `Created event ${res.data.id} — ${res.data.htmlLink ?? "(no link)"}`;
  }
}

interface UpdateEventInput extends Record<string, unknown> {
  calendar_id?: string;
  event_id: string;
  title?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  send_updates?: "all" | "externalOnly" | "none";
}

export class UpdateEventTool extends BaseTool<UpdateEventInput> {
  readonly name = "google_calendar_update_event";
  readonly description =
    "Patch fields on an existing Google Calendar event. Only the fields you pass are touched. Use `send_updates=all` to notify attendees.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "Calendar id; defaults to 'primary'" },
      event_id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      send_updates: { type: "string", enum: ["all", "externalOnly", "none"] },
    },
    required: ["event_id"],
  };
  readonly tags = ["write", "google", "calendar"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: UpdateEventInput, _ctx: ToolContext): Promise<string> {
    const { cal } = calendarFor(this.service);
    const requestBody: Record<string, unknown> = {};
    if (input.title !== undefined) requestBody.summary = input.title;
    if (input.description !== undefined) requestBody.description = input.description;
    if (input.location !== undefined) requestBody.location = input.location;
    if (input.start !== undefined) {
      requestBody.start = isYmd(input.start)
        ? { date: input.start }
        : { dateTime: new Date(input.start).toISOString() };
    }
    if (input.end !== undefined) {
      requestBody.end = isYmd(input.end)
        ? { date: input.end }
        : { dateTime: new Date(input.end).toISOString() };
    }
    await cal.events.patch({
      calendarId: input.calendar_id ?? "primary",
      eventId: input.event_id,
      requestBody,
      sendUpdates: input.send_updates ?? "none",
    });
    return `Patched event ${input.event_id}.`;
  }
}

interface DeleteEventInput extends Record<string, unknown> {
  calendar_id?: string;
  event_id: string;
  send_updates?: "all" | "externalOnly" | "none";
}

export class DeleteEventTool extends BaseTool<DeleteEventInput> {
  readonly name = "google_calendar_delete_event";
  readonly description = "Delete a Google Calendar event by id.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "Calendar id; defaults to 'primary'" },
      event_id: { type: "string" },
      send_updates: { type: "string", enum: ["all", "externalOnly", "none"] },
    },
    required: ["event_id"],
  };
  readonly tags = ["write", "google", "calendar"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: DeleteEventInput, _ctx: ToolContext): Promise<string> {
    const { cal } = calendarFor(this.service);
    await cal.events.delete({
      calendarId: input.calendar_id ?? "primary",
      eventId: input.event_id,
      sendUpdates: input.send_updates ?? "none",
    });
    return `Deleted event ${input.event_id}.`;
  }
}

interface RsvpEventInput extends Record<string, unknown> {
  calendar_id?: string;
  event_id: string;
  response: "accepted" | "declined" | "tentative";
}

export class RsvpEventTool extends BaseTool<RsvpEventInput> {
  readonly name = "google_calendar_rsvp_event";
  readonly description =
    "Update the user's response to a Google Calendar event (accepted / declined / tentative). Operates against the connected user's attendee record on the event.";
  readonly inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "Calendar id; defaults to 'primary'" },
      event_id: { type: "string" },
      response: { type: "string", enum: ["accepted", "declined", "tentative"] },
    },
    required: ["event_id", "response"],
  };
  readonly tags = ["write", "google", "calendar"] as const;

  constructor(private readonly service: GoogleAuthService) {
    super();
  }

  async run(input: RsvpEventInput, _ctx: ToolContext): Promise<string> {
    const { cal } = calendarFor(this.service);
    const calendarId = input.calendar_id ?? "primary";
    const existing = await cal.events.get({ calendarId, eventId: input.event_id });
    const updated = (existing.data.attendees ?? []).map((a) => {
      if (!a.self) return a;
      return { ...a, responseStatus: input.response };
    });
    await cal.events.patch({
      calendarId,
      eventId: input.event_id,
      sendUpdates: "all",
      requestBody: { attendees: updated },
    });
    return `RSVP=${input.response} on event ${input.event_id}.`;
  }
}

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export const googleCalendarGroup: ToolGroup = {
  name: "google_calendar",
  description:
    "Read and write Google Calendar — list calendars, list/search events, create/update/delete events, RSVP.",
  toolNames: [
    "google_calendar_list_calendars",
    "google_calendar_list_events",
    "google_calendar_create_event",
    "google_calendar_update_event",
    "google_calendar_delete_event",
    "google_calendar_rsvp_event",
  ],
  guidance: GOOGLE_CALENDAR_GUIDANCE,
};

export function registerGoogleCalendarTools(
  registry: { register(tool: AnyTool): unknown },
  service: GoogleAuthService,
): void {
  registry.register(new ListCalendarsTool(service) as unknown as AnyTool);
  registry.register(new ListEventsTool(service) as unknown as AnyTool);
  registry.register(new CreateEventTool(service) as unknown as AnyTool);
  registry.register(new UpdateEventTool(service) as unknown as AnyTool);
  registry.register(new DeleteEventTool(service) as unknown as AnyTool);
  registry.register(new RsvpEventTool(service) as unknown as AnyTool);
}
