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
    for (const j of jobs.jobs) this.entries.set(j.id, j);
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
    if (input.prompt !== undefined && next.payload.kind === "prompt") {
      next.payload = { ...next.payload, text: input.prompt };
    } else if (input.prompt !== undefined) {
      next.payload = { kind: "prompt", text: input.prompt };
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

  // ---- helpers --------------------------------------------------------

  private toRecord(job: PersistedJob): RoutineRecord {
    const state = this.states.get(job.id) ?? { ...EMPTY_STATE };
    const cron = job.schedule.kind === "cron" ? job.schedule.expr : "";
    const prompt = job.payload.kind === "prompt" ? job.payload.text : "";
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
        payload: d.payload ?? { kind: "prompt", text: d.prompt },
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
    payload: { kind: "prompt", text: input.prompt },
    session: { kind: "new" },
    execution: input.model ? { model: input.model } : {},
    delivery: input.delivery,
  };
}

function normalizeDelivery(d: RoutineDescriptor["delivery"] | undefined): RoutineDelivery {
  if (!d) return DEFAULT_DELIVERY;
  if (typeof d === "string") {
    return d === "silent" ? { kind: "silent" } : { kind: "dashboard" };
  }
  return d;
}
