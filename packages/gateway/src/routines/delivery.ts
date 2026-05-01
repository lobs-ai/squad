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
 * Fan-out registry for routine delivery. Each delivery `kind` maps to at
 * most one handler. The gateway registers `silent` and `dashboard` itself;
 * channels that want to post to their platform (discord, slack, …) register
 * a handler for their kind via `GatewayAPI.delivery.register`.
 */
export class DeliveryRegistry {
  private readonly handlers: Map<string, DeliveryHandler> = new Map();

  constructor(
    private readonly broadcast: Broadcast,
    private readonly logger: Logger,
  ) {
    this.handlers.set("silent", async () => ({ ok: true }));
    this.handlers.set("dashboard", async () => {
      // Dashboard delivery is implicit: the routine store publishes
      // `routines.fired/<sessionId>` from its onFired callback, which the
      // dashboard already subscribes to for both the activity feed and the
      // run-history panel refresh. Nothing extra to do here.
      return { ok: true };
    });
  }

  register(kind: string, handler: DeliveryHandler): void {
    if (this.handlers.has(kind) && kind !== "silent" && kind !== "dashboard") {
      this.logger.warn({ kind }, "delivery handler replaced");
    }
    this.handlers.set(kind, handler);
  }

  unregister(kind: string): void {
    if (kind === "silent" || kind === "dashboard") return;
    this.handlers.delete(kind);
  }

  /**
   * Dispatch the delivery for a fire. If the silent wake-gate fired
   * (`[SILENT]` first line), all handlers see `silentGate: true` — the
   * built-in handlers honor that by no-opping. Custom handlers are still
   * invoked; they decide whether to respect the gate.
   */
  async dispatch(ctx: DeliveryContext): Promise<{ ok: boolean; error?: string }> {
    if (ctx.silentGate) return { ok: true };
    const handler = this.handlers.get(ctx.delivery.kind);
    if (!handler) {
      const error = `no delivery handler registered for kind "${ctx.delivery.kind}"`;
      this.logger.warn({ kind: ctx.delivery.kind, routineId: ctx.routineId }, error);
      return { ok: false, error };
    }
    try {
      return await handler(ctx);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err, kind: ctx.delivery.kind, routineId: ctx.routineId },
        "delivery handler threw",
      );
      return { ok: false, error };
    }
  }

  /** Test/inspect helper — returns the registered kind names. */
  kinds(): string[] {
    return Array.from(this.handlers.keys());
  }
}
