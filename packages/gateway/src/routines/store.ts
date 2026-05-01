import { randomUUID } from "node:crypto";
import type { RoutineDescriptor } from "@squad/plugin-sdk";
import type {
  Execution,
  FailureConfig,
  Payload,
  RoutineDelivery,
  RoutineRecord,
  Schedule,
  SessionTarget,
} from "@squad/protocol";
import {
  ensureCronPaths,
  readJsonOrEmpty,
  writeJsonAtomic,
  type CronPaths,
} from "./persistence.js";

/**
 * Backend interface for the runner — supplied by the gateway boot. Returns
 * the sessionId associated with the run (null when the payload runs without
 * a session, e.g. `script`).
 */
export interface RoutineRunner {
  (routine: RoutineRecord): Promise<{ sessionId: string | null }>;
}

export interface RoutineStoreCallbacks {
  onFired?: (event: {
    routineId: string;
    sessionId: string | null;
    firedAt: string;
    status?: "ok" | "error" | "skipped";
  }) => void;
  onChanged?: (record: RoutineRecord | null) => void;
}

interface PersistedJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  payload: Payload;
  session: SessionTarget;
  execution: Execution;
  failure?: FailureConfig;
  delivery: RoutineDelivery;
  createdAt: string;
}

interface PersistedState {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  consecutiveErrors: number;
  lastAlertAt?: string | null;
}

interface JobsFile {
  version: 1;
  jobs: PersistedJob[];
}
interface StateFile {
  version: 1;
  state: Record<string, PersistedState>;
}

const DEFAULT_DELIVERY: RoutineDelivery = { kind: "dashboard" };
const EMPTY_STATE: PersistedState = {
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  consecutiveErrors: 0,
  lastAlertAt: null,
};

/**
 * File-backed list of routines. Loads `jobs.json` + `state.json` from
 * `<dataDir>/cron/` on construction. Mutations write through to disk
 * atomically. State is split from config so per-run updates don't churn
 * the file the user might be editing or committing to git.
 *
 * When `dataDir` is null/undefined the store operates in pure in-memory
 * mode — used by tests that don't want filesystem coupling.
 */
export class RoutineStore {
  private readonly entries: Map<string, PersistedJob> = new Map();
  private readonly states: Map<string, PersistedState> = new Map();
  private readonly paths: CronPaths | null;
  private readonly cb: RoutineStoreCallbacks;

  constructor(cb: RoutineStoreCallbacks = {}, opts: { dataDir?: string | null } = {}) {
    this.cb = cb;
    this.paths = opts.dataDir ? ensureCronPaths(opts.dataDir) : null;
    this.hydrate();
  }

  private hydrate(): void {
    if (!this.paths) return;
    const jobs = readJsonOrEmpty<JobsFile>(this.paths.jobs, { version: 1, jobs: [] });
    const state = readJsonOrEmpty<StateFile>(this.paths.state, { version: 1, state: {} });
    for (const j of jobs.jobs) this.entries.set(j.id, migratePersistedJob(j));
    for (const [id, s] of Object.entries(state.state)) this.states.set(id, { ...EMPTY_STATE, ...s });
  }

  private flushJobs(): void {
    if (!this.paths) return;
    const file: JobsFile = { version: 1, jobs: Array.from(this.entries.values()) };
    writeJsonAtomic(this.paths.jobs, file);
  }

  flushState(): void {
    if (!this.paths) return;
    const obj: Record<string, PersistedState> = {};
    for (const [id, s] of this.states.entries()) obj[id] = s;
    const file: StateFile = { version: 1, state: obj };
    writeJsonAtomic(this.paths.state, file);
  }

  // ---- public API ------------------------------------------------------

  list(): RoutineRecord[] {
    const out: RoutineRecord[] = [];
    for (const job of this.entries.values()) out.push(this.toRecord(job));
    return out;
  }

  get(id: string): RoutineRecord | null {
    const job = this.entries.get(id);
    return job ? this.toRecord(job) : null;
  }

  /** Internal accessor: get the raw stored job (without record projection). */
  getJob(id: string): PersistedJob | null {
    return this.entries.get(id) ?? null;
  }

  /** Internal accessor for the scheduler. */
  getState(id: string): PersistedState {
    return this.states.get(id) ?? { ...EMPTY_STATE };
  }

  setState(id: string, patch: Partial<PersistedState>): void {
    const cur = this.states.get(id) ?? { ...EMPTY_STATE };
    const next = { ...cur, ...patch };
    this.states.set(id, next);
    this.flushState();
    const job = this.entries.get(id);
    if (job) this.cb.onChanged?.(this.toRecord(job));
  }

  /** All persisted job IDs. Used by run-log pruning. */
  ids(): Set<string> {
    return new Set(this.entries.keys());
  }

  // ---- create / update / delete ---------------------------------------

  /**
   * Convert a plugin RoutineDescriptor into a stored job. Idempotent on
   * `name` so re-loading a plugin doesn't duplicate entries.
   */
  adoptFromPlugin(d: RoutineDescriptor): RoutineRecord {
    const existing = Array.from(this.entries.values()).find((j) => j.name === d.name);
    if (existing) return this.toRecord(existing);
    return this.create(this.descriptorToCreateInput(d));
  }

  create(input: CreateInput): RoutineRecord {
    const normalized = normalizeCreateInput(input);
    const id = "rt_" + randomUUID().slice(0, 8);
    const job: PersistedJob = {
      id,
      name: normalized.name,
      enabled: normalized.enabled,
      schedule: normalized.schedule,
      payload: normalized.payload,
      session: normalized.session,
      execution: normalized.execution,
      ...(normalized.failure ? { failure: normalized.failure } : {}),
      delivery: normalized.delivery,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(id, job);
    this.states.set(id, { ...EMPTY_STATE });
    this.flushJobs();
    this.flushState();
    const rec = this.toRecord(job);
    this.cb.onChanged?.(rec);
    return rec;
  }

  update(input: UpdateInput): RoutineRecord | null {
    const job = this.entries.get(input.id);
    if (!job) return null;
    const next: PersistedJob = {
      ...job,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.execution !== undefined ? { execution: input.execution } : {}),
      ...(input.failure !== undefined ? { failure: input.failure } : {}),
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    };
    // Legacy passthroughs: cron/prompt/model on the wire mutate the
    // structured fields underneath.
    if (input.cron !== undefined) {
      next.schedule = { kind: "cron", expr: input.cron };
    }
    if (input.prompt !== undefined) {
      next.payload = legacyPromptToPayload(input.prompt);
    }
    if (input.model !== undefined) {
      next.execution = { ...next.execution, model: input.model };
    }
    this.entries.set(job.id, next);
    this.flushJobs();
    const rec = this.toRecord(next);
    this.cb.onChanged?.(rec);
    return rec;
  }

  delete(id: string): boolean {
    const had = this.entries.delete(id);
    if (had) {
      this.states.delete(id);
      this.flushJobs();
      this.flushState();
      this.cb.onChanged?.(null);
    }
    return had;
  }

  markFired(
    id: string,
    sessionId: string | null,
    status: "ok" | "error" | "skipped" = "ok",
    firedAt: string = new Date().toISOString(),
    error: string | null = null,
  ): void {
    if (!this.entries.has(id)) return;
    const cur = this.states.get(id) ?? { ...EMPTY_STATE };
    const consecutiveErrors = status === "error" ? cur.consecutiveErrors + 1 : 0;
    const next: PersistedState = {
      ...cur,
      lastRunAt: firedAt,
      lastStatus: status,
      lastError: error,
      consecutiveErrors,
    };
    this.states.set(id, next);
    this.flushState();
    this.cb.onFired?.({ routineId: id, sessionId, firedAt, status });
    const job = this.entries.get(id);
    if (job) this.cb.onChanged?.(this.toRecord(job));
  }

  async runNow(id: string, runner: RoutineRunner): Promise<{ sessionId: string | null }> {
    const job = this.entries.get(id);
    if (!job) throw new Error(`unknown routine: ${id}`);
    const result = await runner(this.toRecord(job));
    this.markFired(id, result.sessionId);
    return result;
  }

  /**
   * Fire a webhook-scheduled routine — same path as `runNow` but the caller
   * supplies an arbitrary payload context that gets substituted into the
   * routine's prompt body (or scriptThenPrompt's inner prompt). The runtime
   * is responsible for verifying the routine's `schedule.kind === "webhook"`
   * before calling.
   */
  async fireWebhook(
    id: string,
    runner: RoutineRunner,
    ctx: WebhookFireContext,
  ): Promise<{ sessionId: string | null }> {
    const job = this.entries.get(id);
    if (!job) throw new Error(`unknown routine: ${id}`);
    const rec = this.toRecord(job);
    const enriched = applyWebhookContext(rec, ctx);
    const result = await runner(enriched);
    this.markFired(id, result.sessionId);
    return result;
  }

  // ---- helpers --------------------------------------------------------

  private toRecord(job: PersistedJob): RoutineRecord {
    const state = this.states.get(job.id) ?? { ...EMPTY_STATE };
    const cron = job.schedule.kind === "cron" ? job.schedule.expr : "";
    const prompt = legacyPromptMirror(job.payload);
    const model = job.execution.model ?? null;
    const rec: RoutineRecord = {
      id: job.id,
      name: job.name,
      enabled: job.enabled,
      schedule: job.schedule,
      payload: job.payload,
      session: job.session,
      execution: job.execution,
      ...(job.failure ? { failure: job.failure } : {}),
      delivery: job.delivery,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      consecutiveErrors: state.consecutiveErrors,
      cron,
      prompt,
      model,
    };
    return rec;
  }

  private descriptorToCreateInput(d: RoutineDescriptor): CreateInput {
    if (d.schedule || d.payload || d.session || d.execution) {
      return {
        name: d.name,
        enabled: true,
        schedule: d.schedule ?? { kind: "cron", expr: d.cron },
        payload: d.payload ?? legacyPromptToPayload(d.prompt),
        session: d.session ?? { kind: "new" },
        execution: d.execution ?? (d.model ? { model: d.model } : {}),
        delivery: normalizeDelivery(d.delivery),
      };
    }
    return {
      name: d.name,
      cron: d.cron,
      prompt: d.prompt,
      ...(d.model !== undefined ? { model: d.model } : {}),
      delivery: normalizeDelivery(d.delivery),
      enabled: true,
    };
  }
}

// -- Input normalization ---------------------------------------------------

/**
 * Either the structured form or the legacy flat form. Mirrors the protocol
 * routinesCreateParams union — accepted at the dispatch layer and passed
 * straight through.
 */
export type CreateInput =
  | {
      name: string;
      enabled?: boolean;
      schedule: Schedule;
      payload: Payload;
      session?: SessionTarget;
      execution?: Execution;
      failure?: FailureConfig;
      delivery: RoutineDelivery;
    }
  | {
      name: string;
      cron: string;
      prompt: string;
      model?: string;
      delivery: RoutineDelivery;
      enabled?: boolean;
    };

export type UpdateInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: Schedule;
  payload?: Payload;
  session?: SessionTarget;
  execution?: Execution;
  failure?: FailureConfig;
  delivery?: RoutineDelivery;
  // Legacy passthroughs:
  cron?: string;
  prompt?: string;
  model?: string | null;
};

interface NormalizedCreate {
  name: string;
  enabled: boolean;
  schedule: Schedule;
  payload: Payload;
  session: SessionTarget;
  execution: Execution;
  failure?: FailureConfig;
  delivery: RoutineDelivery;
}

function normalizeCreateInput(input: CreateInput): NormalizedCreate {
  if ("schedule" in input) {
    return {
      name: input.name,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      payload: input.payload,
      session: input.session ?? { kind: "new" },
      execution: input.execution ?? {},
      ...(input.failure ? { failure: input.failure } : {}),
      delivery: input.delivery,
    };
  }
  return {
    name: input.name,
    enabled: input.enabled ?? true,
    schedule: { kind: "cron", expr: input.cron },
    payload: legacyPromptToPayload(input.prompt),
    session: { kind: "new" },
    execution: input.model ? { model: input.model } : {},
    delivery: input.delivery,
  };
}

/**
 * Map a flat-shape `prompt: string` (from legacy create input or descriptors)
 * into the structured prompt payload — a single user message.
 */
function legacyPromptToPayload(prompt: string): Payload {
  return { kind: "prompt", messages: [{ role: "user", text: prompt }] };
}

/**
 * Populate the legacy `RoutineRecord.prompt` mirror. Old clients read this
 * field as a flat string. We can only honor that when the payload is a
 * single user message with no skills or system messages — otherwise we
 * leave it empty and let the client fall back to `payload.messages`.
 */
function legacyPromptMirror(payload: Payload): string {
  if (payload.kind !== "prompt") return "";
  if (payload.skills && payload.skills.length > 0) return "";
  if (payload.messages.length !== 1) return "";
  const only = payload.messages[0]!;
  if (only.role !== "user") return "";
  return only.text;
}

/**
 * Transparently rewrite jobs.json entries persisted before the payload
 * collapse: the old `{ kind: "prompt", text }` and `{ kind: "agentTurn",
 * messages }` shapes both become the new `{ kind: "prompt", messages }`.
 * Existing files keep working without manual migration.
 */
function migratePersistedJob(job: PersistedJob): PersistedJob {
  const p = job.payload as unknown as { kind: string; [k: string]: unknown };
  if (p.kind === "prompt" && typeof p.text === "string" && !Array.isArray(p.messages)) {
    const skills = Array.isArray(p.skills) ? (p.skills as string[]) : undefined;
    const next: Payload = {
      kind: "prompt",
      messages: [{ role: "user", text: p.text as string }],
      ...(skills ? { skills } : {}),
    };
    return { ...job, payload: next };
  }
  if (p.kind === "agentTurn" && Array.isArray(p.messages)) {
    const next: Payload = {
      kind: "prompt",
      messages: p.messages as Array<{ role: "user" | "system"; text: string }>,
    };
    return { ...job, payload: next };
  }
  return job;
}

function normalizeDelivery(d: RoutineDescriptor["delivery"] | undefined): RoutineDelivery {
  if (!d) return DEFAULT_DELIVERY;
  if (typeof d === "string") {
    return d === "silent" ? { kind: "silent" } : { kind: "dashboard" };
  }
  return d;
}

// -- Webhook payload substitution -----------------------------------------

export interface WebhookFireContext {
  /** Raw decoded body. May be a parsed JSON value or a string when it isn't JSON. */
  body: unknown;
  /** Lowercased header map (last value wins for duplicates). */
  headers: Record<string, string>;
  /** Query-string params from the webhook URL. */
  query: Record<string, string>;
  /**
   * Raw text body — supplied so prompt-style payloads with no `{{body}}`
   * placeholder can fall back to appending the raw text. JSON bodies get
   * stringified for substitution.
   */
  rawBody: string;
}

/**
 * Substitute `{{body}}`, `{{header.X}}`, `{{query.X}}` placeholders in the
 * routine's prompt messages. Anything not matched stays literal. If no
 * substitution actually changed any text, the raw body is appended as a
 * final user message so the agent always sees the trigger content.
 *
 * `script` payloads are passed through unchanged — script kinds receive
 * webhook context via env vars in the executor, not via text substitution.
 * `scriptThenPrompt` substitutes into its inner `prompt.messages` only;
 * the script's command/args remain literal.
 */
export function applyWebhookContext(
  rec: RoutineRecord,
  ctx: WebhookFireContext,
): RoutineRecord {
  const substitute = (s: string): string =>
    s
      .replace(/\{\{\s*body\s*\}\}/g, ctx.rawBody)
      .replace(/\{\{\s*header\.([\w-]+)\s*\}\}/g, (_m, name: string) => {
        return ctx.headers[name.toLowerCase()] ?? "";
      })
      .replace(/\{\{\s*query\.([\w-]+)\s*\}\}/g, (_m, name: string) => {
        return ctx.query[name] ?? "";
      });

  const substituteMessages = (
    messages: Array<{ role: "user" | "system"; text: string }>,
  ): Array<{ role: "user" | "system"; text: string }> => {
    const next = messages.map((m) => ({ ...m, text: substitute(m.text) }));
    const anyChanged = next.some((m, i) => m.text !== messages[i]!.text);
    if (!anyChanged && ctx.rawBody.trim().length > 0) {
      next.push({ role: "user", text: ctx.rawBody });
    }
    return next;
  };

  let payload: Payload = rec.payload;
  if (rec.payload.kind === "prompt") {
    payload = { ...rec.payload, messages: substituteMessages(rec.payload.messages) };
  } else if (rec.payload.kind === "scriptThenPrompt") {
    payload = {
      ...rec.payload,
      prompt: { ...rec.payload.prompt, messages: substituteMessages(rec.payload.prompt.messages) },
    };
  }
  return { ...rec, payload };
}
