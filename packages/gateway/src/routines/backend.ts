import type {
  CronBackend,
  CronJobSummary,
  CronRunSummary,
  CronDeliveryInput,
  CronExecutionInput,
  CronPayloadInput,
  CronScheduleInput,
  CronSessionTargetInput,
  DeliveryKindInfo,
} from "@squad/tools";
import type { RoutineDelivery, RoutineRecord } from "@squad/protocol";
import type { RoutineRunner, RoutineStore } from "./store.js";
import { readRunLog, type CronPaths } from "./persistence.js";
import type { DeliveryRegistry } from "./delivery.js";

export interface CronBackendDeps {
  store: RoutineStore;
  runner: RoutineRunner;
  paths: CronPaths;
  /**
   * Delivery registry — used by the agent-facing `list_delivery_kinds`
   * tool so the LLM can discover which channel handlers are loaded
   * (silent, dashboard, discord, plugin-registered slack/webhook/…).
   * Optional; when omitted, listDeliveryKinds returns just the gateway
   * built-ins.
   */
  delivery?: DeliveryRegistry;
}

const BUILT_IN_DELIVERY: DeliveryKindInfo[] = [
  {
    kind: "silent",
    builtIn: true,
    description: "Run is logged; nothing is sent anywhere.",
  },
  {
    kind: "dashboard",
    builtIn: true,
    description:
      "The resulting session opens in the dashboard chat UI. Implicit; no extras needed.",
  },
  {
    kind: "discord",
    builtIn: false,
    description:
      "Posts the run output into a Discord channel. Requires the channel-discord plugin.",
    extrasSchema: {
      channelId: { type: "string", description: "Discord channel snowflake (required)" },
      guildId: { type: "string", description: "Optional guild id" },
    },
  },
];

/**
 * Adapt the in-process RoutineStore + RoutineRunner into the CronBackend
 * interface the agent tools talk to. Lives in the gateway because the tools
 * package must not import from the gateway directly.
 */
export function cronBackendFor(deps: CronBackendDeps): CronBackend {
  const { store, runner, paths, delivery } = deps;
  return {
    async list() {
      return store.list().map(toSummary);
    },
    async get(id) {
      const r = store.get(id);
      return r ? toSummary(r) : null;
    },
    async listDeliveryKinds() {
      // The DeliveryRegistry holds the source of truth — built-ins
      // (silent, dashboard) plus anything plugins registered. Merge with
      // BUILT_IN_DELIVERY so the rich descriptions/extras schemas come
      // along even when the registry only knows the bare names.
      const registered = delivery ? delivery.kinds() : ["silent", "dashboard"];
      const seen = new Set<string>();
      const out: DeliveryKindInfo[] = [];
      for (const meta of BUILT_IN_DELIVERY) {
        if (registered.includes(meta.kind)) {
          out.push(meta);
          seen.add(meta.kind);
        }
      }
      for (const kind of registered) {
        if (seen.has(kind)) continue;
        out.push({ kind, builtIn: kind === "silent" || kind === "dashboard" });
      }
      return out;
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
  if (d.kind === "discord") {
    if (!d.channelId) {
      throw new Error("discord delivery requires `channelId`");
    }
    return {
      kind: "discord",
      channelId: d.channelId,
      ...(d.guildId ? { guildId: d.guildId } : {}),
    };
  }
  // Plugin-registered kind (e.g. "slack"). Forward extras verbatim.
  return { kind: d.kind, ...(d.extras ?? {}) };
}

function fromDelivery(d: RoutineDelivery): CronDeliveryInput {
  if (d.kind === "silent" || d.kind === "dashboard") return { kind: d.kind };
  if (d.kind === "discord") {
    const dd = d as { kind: "discord"; channelId: string; guildId?: string };
    return {
      kind: "discord",
      channelId: dd.channelId,
      ...(dd.guildId ? { guildId: dd.guildId } : {}),
    };
  }
  // Plugin-registered kind: lift everything except `kind` into `extras`.
  const { kind, ...rest } = d as { kind: string; [k: string]: unknown };
  const extras = rest as Record<string, unknown>;
  return {
    kind,
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}
