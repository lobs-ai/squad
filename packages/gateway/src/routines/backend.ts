import type {
  CronBackend,
  CronJobSummary,
  CronRunSummary,
  CronDeliveryInput,
  CronExecutionInput,
  CronPayloadInput,
  CronScheduleInput,
  CronSessionTargetInput,
} from "@squad/tools";
import type { RoutineDelivery, RoutineRecord } from "@squad/protocol";
import type { RoutineRunner, RoutineStore } from "./store.js";
import { readRunLog, type CronPaths } from "./persistence.js";

export interface CronBackendDeps {
  store: RoutineStore;
  runner: RoutineRunner;
  paths: CronPaths;
}

/**
 * Adapt the in-process RoutineStore + RoutineRunner into the CronBackend
 * interface the agent tools talk to. Lives in the gateway because the tools
 * package must not import from the gateway directly.
 */
export function cronBackendFor(deps: CronBackendDeps): CronBackend {
  const { store, runner, paths } = deps;
  return {
    async list() {
      return store.list().map(toSummary);
    },
    async get(id) {
      const r = store.get(id);
      return r ? toSummary(r) : null;
    },
    async create(input) {
      const rec = store.create({
        name: input.name,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        payload: input.payload,
        session: input.session ?? { kind: "new" },
        execution: input.execution ?? {},
        delivery: input.delivery ? toDelivery(input.delivery) : { kind: "dashboard" },
      });
      return toSummary(rec);
    },
    async update(input) {
      const rec = store.update({
        id: input.id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.session !== undefined ? { session: input.session } : {}),
        ...(input.execution !== undefined ? { execution: input.execution } : {}),
        ...(input.delivery !== undefined ? { delivery: toDelivery(input.delivery) } : {}),
      });
      if (!rec) throw new Error(`unknown cron job: ${input.id}`);
      return toSummary(rec);
    },
    async delete(id) {
      const ok = store.delete(id);
      if (!ok) throw new Error(`unknown cron job: ${id}`);
      return { id };
    },
    async runNow(id) {
      const result = await store.runNow(id, runner);
      return { sessionId: result.sessionId };
    },
    async runs(input) {
      const limit = input.limit ?? 20;
      return readRunLog(paths.runs, input.id, {
        limit,
        ...(input.status ? { status: input.status } : {}),
      }).map(toRunSummary);
    },
  };
}

function toSummary(r: RoutineRecord): CronJobSummary {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    schedule: r.schedule as CronScheduleInput,
    payload: r.payload as CronPayloadInput,
    session: r.session as CronSessionTargetInput,
    execution: r.execution as CronExecutionInput,
    delivery: fromDelivery(r.delivery),
    lastRunAt: r.lastRunAt,
    nextRunAt: r.nextRunAt,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    consecutiveErrors: r.consecutiveErrors,
  };
}

function toRunSummary(r: import("@squad/protocol").RoutineRunLog): CronRunSummary {
  return {
    ts: r.ts,
    status: r.status,
    durationMs: r.durationMs,
    payloadKind: r.payloadKind,
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.output !== undefined ? { output: r.output } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.tokens !== undefined ? { tokens: r.tokens } : {}),
  };
}

function toDelivery(d: CronDeliveryInput): RoutineDelivery {
  if (d.kind === "silent") return { kind: "silent" };
  if (d.kind === "dashboard") return { kind: "dashboard" };
  if (!d.channelId) {
    throw new Error("discord delivery requires `channelId`");
  }
  return {
    kind: "discord",
    channelId: d.channelId,
    ...(d.guildId ? { guildId: d.guildId } : {}),
  };
}

function fromDelivery(d: RoutineDelivery): CronDeliveryInput {
  if (d.kind === "silent" || d.kind === "dashboard") return { kind: d.kind };
  return {
    kind: "discord",
    channelId: d.channelId,
    ...(d.guildId ? { guildId: d.guildId } : {}),
  };
}
