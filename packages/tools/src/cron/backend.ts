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

export type PayloadInput =
  | { kind: "prompt"; text: string; skills?: string[] }
  | { kind: "agentTurn"; messages: Array<{ role: "user" | "system"; text: string }> }
  | { kind: "script"; command: string; args?: string[]; cwd?: string };

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

export interface DeliveryInput {
  kind: "silent" | "dashboard" | "discord";
  channelId?: string;
  guildId?: string;
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
  payloadKind: "prompt" | "agentTurn" | "script";
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
