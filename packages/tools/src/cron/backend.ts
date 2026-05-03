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
 * Where a cron job's output should be sent. Built-in kinds are `silent` and
 * `dashboard`; any other string targets a plugin-registered handler (e.g.
 * `"slack"`, or `"discord"` from the channel-discord plugin). Plugin
 * handlers validate their own extra fields, passed through verbatim via
 * `extras`.
 */
export interface DeliveryInput {
  kind: string;
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

export interface DeliveryKindInfo {
  kind: string;
  /** True for kinds the gateway always provides (silent, dashboard). */
  builtIn: boolean;
  /** Optional human-readable description ("posts to a channel"). */
  description?: string;
  /**
   * Optional JSON-Schema-shaped sketch of additional fields the handler
   * expects on the routine's `delivery` object (beyond `kind`). Plugins
   * that don't supply this still work — the agent just has to guess
   * fields from documentation.
   */
  extrasSchema?: Record<string, unknown>;
}

export interface CronBackend {
  list(): Promise<CronJobSummary[]>;
  get(id: string): Promise<CronJobSummary | null>;
  /** Registered delivery handler kinds (built-in + plugin-registered). */
  listDeliveryKinds(): Promise<DeliveryKindInfo[]>;
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
