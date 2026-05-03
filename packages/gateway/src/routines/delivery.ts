import type { RoutineDelivery } from "@squad/protocol";
import type { Logger } from "../logger.js";
import type { Broadcast } from "../broadcast.js";

/**
 * Context handed to a {@link DeliveryHandler} for a single fire. The handler
 * decides what to do: post to a channel, ignore, hit a webhook, etc. Handlers
 * are pure side-effect — return `{ ok: true }` on success or `{ ok: false,
 * error }` on failure. Failure does not change the routine's `lastStatus`,
 * but is recorded into the run-log entry's `delivery` field.
 */
export interface DeliveryContext {
  routineId: string;
  routineName: string;
  delivery: RoutineDelivery;
  runId: string;
  sessionId: string | null;
  payloadKind: "prompt" | "script" | "scriptThenPrompt";
  output?: string;
  tokens?: { in: number; out: number };
  /** True when the executor saw `[SILENT]` and is suppressing delivery. */
  silentGate: boolean;
}

export type DeliveryHandler = (
  ctx: DeliveryContext,
) => Promise<{ ok: boolean; error?: string }>;

/**
 * Optional metadata supplied at register time so `list_delivery_kinds` can
 * surface a description and (where useful) a sketch of the `extras` fields
 * the handler expects. The agent uses this to know how to fill out
 * `delivery.extras` without reading the plugin's source.
 */
export interface DeliveryKindMeta {
  description?: string;
  extrasSchema?: Record<string, unknown>;
}

interface DeliveryEntry {
  handler: DeliveryHandler;
  meta?: DeliveryKindMeta;
}

export interface DeliveryKindEntry extends DeliveryKindMeta {
  kind: string;
  builtIn: boolean;
}

/**
 * Fan-out registry for routine delivery. Each delivery `kind` maps to at
 * most one handler. The gateway registers `silent` and `dashboard` itself;
 * plugins register their own kinds (discord, slack, webhook, …) via
 * `GatewayAPI.delivery.register`.
 */
export class DeliveryRegistry {
  private readonly entries: Map<string, DeliveryEntry> = new Map();
  /**
   * Optional callback fired on every register/unregister. The gateway uses
   * this to keep the live PromptContext snapshot's deliveryKinds in sync —
   * each mutation triggers tools that render delivery info to recompute
   * their description.
   */
  onChange?: () => void;

  constructor(
    private readonly broadcast: Broadcast,
    private readonly logger: Logger,
  ) {
    this.entries.set("silent", {
      handler: async () => ({ ok: true }),
      meta: { description: "Run is logged; nothing is sent anywhere." },
    });
    this.entries.set("dashboard", {
      handler: async () => {
        // Dashboard delivery is implicit: the routine store publishes
        // `routines.fired/<sessionId>` from its onFired callback, which the
        // dashboard already subscribes to for both the activity feed and the
        // run-history panel refresh. Nothing extra to do here.
        return { ok: true };
      },
      meta: {
        description:
          "The resulting session opens in the dashboard chat UI. Implicit; no extras needed.",
      },
    });
  }

  register(kind: string, handler: DeliveryHandler, meta?: DeliveryKindMeta): void {
    if (this.entries.has(kind) && kind !== "silent" && kind !== "dashboard") {
      this.logger.warn({ kind }, "delivery handler replaced");
    }
    this.entries.set(kind, meta ? { handler, meta } : { handler });
    this.onChange?.();
  }

  unregister(kind: string): void {
    if (kind === "silent" || kind === "dashboard") return;
    if (this.entries.delete(kind)) this.onChange?.();
  }

  /**
   * Dispatch the delivery for a fire. If the silent wake-gate fired
   * (`[SILENT]` first line), all handlers see `silentGate: true` — the
   * built-in handlers honor that by no-opping. Custom handlers are still
   * invoked; they decide whether to respect the gate.
   */
  async dispatch(ctx: DeliveryContext): Promise<{ ok: boolean; error?: string }> {
    if (ctx.silentGate) return { ok: true };
    const entry = this.entries.get(ctx.delivery.kind);
    if (!entry) {
      const error = `no delivery handler registered for kind "${ctx.delivery.kind}"`;
      this.logger.warn({ kind: ctx.delivery.kind, routineId: ctx.routineId }, error);
      return { ok: false, error };
    }
    try {
      return await entry.handler(ctx);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err, kind: ctx.delivery.kind, routineId: ctx.routineId },
        "delivery handler threw",
      );
      return { ok: false, error };
    }
  }

  /** Registered kind names. */
  kinds(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Registered kinds with their metadata, for `list_delivery_kinds`. */
  list(): DeliveryKindEntry[] {
    return Array.from(this.entries.entries()).map(([kind, entry]) => ({
      kind,
      builtIn: kind === "silent" || kind === "dashboard",
      ...(entry.meta?.description !== undefined ? { description: entry.meta.description } : {}),
      ...(entry.meta?.extrasSchema !== undefined ? { extrasSchema: entry.meta.extrasSchema } : {}),
    }));
  }
}
