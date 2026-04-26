import { randomUUID } from "node:crypto";
import type { RoutineDescriptor } from "@squad/plugin-sdk";
import type { RoutineDelivery, RoutineRecord } from "@squad/protocol";

export interface RoutineRunner {
  /** Execute one routine. Returns the sessionId the prompt is delivered to. */
  (routine: RoutineRecord): Promise<{ sessionId: string }>;
}

export interface RoutineStoreCallbacks {
  onFired?: (event: { routineId: string; sessionId: string; firedAt: string }) => void;
  onChanged?: (record: RoutineRecord | null) => void;
}

interface Entry {
  record: RoutineRecord;
}

const DEFAULT_DELIVERY: RoutineDelivery = { kind: "dashboard" };

/**
 * In-memory list of routines. Plugin-supplied routines and dashboard-created
 * routines both live here; the cron scheduler iterates this list. v1 keeps
 * everything in memory — survives the life of the process, gone on restart.
 * Persistence behind SQLite is the next step when the dashboard grows
 * "remember my routines" UX.
 */
export class RoutineStore {
  private readonly entries: Map<string, Entry> = new Map();

  constructor(private readonly cb: RoutineStoreCallbacks = {}) {}

  list(): RoutineRecord[] {
    return Array.from(this.entries.values()).map((e) => e.record);
  }

  get(id: string): RoutineRecord | null {
    return this.entries.get(id)?.record ?? null;
  }

  /**
   * Convert a plugin RoutineDescriptor into a RoutineRecord and adopt it.
   * Idempotent on `name` so re-loading a plugin doesn't duplicate entries.
   */
  adoptFromPlugin(descriptor: RoutineDescriptor): RoutineRecord {
    const existing = this.list().find((r) => r.name === descriptor.name);
    if (existing) return existing;
    return this.create({
      name: descriptor.name,
      cron: descriptor.cron,
      prompt: descriptor.prompt,
      ...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
      delivery: normalizeDelivery(descriptor.delivery),
      enabled: true,
    });
  }

  create(input: {
    name: string;
    cron: string;
    prompt: string;
    model?: string;
    delivery: RoutineDelivery;
    enabled: boolean;
  }): RoutineRecord {
    const id = "rt_" + randomUUID().slice(0, 8);
    const record: RoutineRecord = {
      id,
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      model: input.model ?? null,
      delivery: input.delivery,
      enabled: input.enabled,
      lastRunAt: null,
      nextRunAt: null,
    };
    this.entries.set(id, { record });
    this.cb.onChanged?.(record);
    return record;
  }

  update(input: {
    id: string;
    name?: string;
    cron?: string;
    prompt?: string;
    model?: string | null;
    delivery?: RoutineDelivery;
    enabled?: boolean;
  }): RoutineRecord | null {
    const e = this.entries.get(input.id);
    if (!e) return null;
    e.record = {
      ...e.record,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.cron !== undefined ? { cron: input.cron } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    this.cb.onChanged?.(e.record);
    return e.record;
  }

  delete(id: string): boolean {
    const had = this.entries.delete(id);
    if (had) this.cb.onChanged?.(null);
    return had;
  }

  markFired(id: string, sessionId: string, firedAt: string = new Date().toISOString()): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.record = { ...e.record, lastRunAt: firedAt };
    this.cb.onFired?.({ routineId: id, sessionId, firedAt });
    this.cb.onChanged?.(e.record);
  }

  async runNow(id: string, runner: RoutineRunner): Promise<{ sessionId: string }> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown routine: ${id}`);
    const { sessionId } = await runner(e.record);
    this.markFired(id, sessionId);
    return { sessionId };
  }
}

function normalizeDelivery(d: RoutineDescriptor["delivery"] | undefined): RoutineDelivery {
  if (!d) return DEFAULT_DELIVERY;
  if (typeof d === "string") {
    return d === "silent" ? { kind: "silent" } : { kind: "dashboard" };
  }
  return d;
}
