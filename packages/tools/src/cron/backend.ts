/**
 * CronBackend — minimal interface the cron tools talk to.
 *
 * The gateway implements this in terms of its RoutineStore + executor; tests
 * stub it. Tools never import from the gateway directly.
 */

export type ScheduleInput =
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "interval"; everyMs: number; anchor?: string }
  | { kind: "once"; at: string };

export interface PromptBody {
  messages: Array<{ role: "user" | "system"; text: string }>;
  skills?: string[];
}

export type PayloadInput =
  | ({ kind: "prompt" } & PromptBody)
  | { kind: "script"; command: string; args?: string[]; cwd?: string }
  | {
      kind: "scriptThenPrompt";
      command: string;
      args?: string[];
      cwd?: string;
      prompt: PromptBody;
    };

export type SessionTargetInput =
  | { kind: "new" }
  | { kind: "isolated" }
  | { kind: "session"; sessionId: string };

export interface ExecutionInput {
  model?: string | null;
  fallbacks?: string[];
  toolsAllow?: string[];
  timeoutSec?: number;
}

/**
 * Where a cron job's output should be sent. Built-in kinds are `silent`,
 * `dashboard`, and `discord`; any other string targets a plugin-registered
 * handler (e.g. `"slack"`). Plugin handlers are responsible for validating
 * their own extra fields (passed through verbatim via `extras`).
 */
export interface DeliveryInput {
  kind: string;
  /** Required when kind === "discord". */
  channelId?: string;
  /** Optional discord guild id. */
  guildId?: string;
  /** Arbitrary extra fields forwarded to plugin-registered handlers. */
  extras?: Record<string, unknown>;
}

export interface CronJobSummary {
  id: string;
  name: string;
  enabled: boolean;
  schedule: ScheduleInput;
  payload: PayloadInput;
  session: SessionTargetInput;
  execution: ExecutionInput;
  delivery: DeliveryInput;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  consecutiveErrors: number;
}

export interface CronRunSummary {
  ts: string;
  status: "ok" | "error" | "skipped";
  durationMs: number;
  sessionId?: string;
  payloadKind: "prompt" | "script" | "scriptThenPrompt";
  output?: string;
  error?: string;
  tokens?: { in: number; out: number };
}

export interface CronBackend {
  list(): Promise<CronJobSummary[]>;
  get(id: string): Promise<CronJobSummary | null>;
  create(input: {
    name: string;
    schedule: ScheduleInput;
    payload: PayloadInput;
    session?: SessionTargetInput;
    execution?: ExecutionInput;
    delivery?: DeliveryInput;
    enabled?: boolean;
  }): Promise<CronJobSummary>;
  update(input: {
    id: string;
    name?: string;
    enabled?: boolean;
    schedule?: ScheduleInput;
    payload?: PayloadInput;
    session?: SessionTargetInput;
    execution?: ExecutionInput;
    delivery?: DeliveryInput;
  }): Promise<CronJobSummary>;
  delete(id: string): Promise<{ id: string }>;
  runNow(id: string): Promise<{ sessionId: string | null }>;
  runs(input: {
    id: string;
    limit?: number;
    status?: "ok" | "error" | "skipped";
  }): Promise<CronRunSummary[]>;
}
