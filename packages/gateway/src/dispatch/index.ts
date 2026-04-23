import type { MethodName, methodRegistry } from "@squad/protocol";
import { methodRegistry as registry, ProtocolError, ErrorCode } from "@squad/protocol";
import type { TokenGrant } from "../auth.js";
import type { Authenticator } from "../auth.js";
import { z } from "zod";

export interface DispatchContext {
  grant: TokenGrant;
  authenticator: Authenticator;
  subscriberId: string;
}

export type Handler<M extends MethodName> = (
  params: z.infer<(typeof methodRegistry)[M]["params"]>,
  ctx: DispatchContext,
) => Promise<z.infer<(typeof methodRegistry)[M]["result"]>>;

type AnyHandler = (params: unknown, ctx: DispatchContext) => Promise<unknown>;

export class Dispatcher {
  private readonly handlers: Map<MethodName, AnyHandler> = new Map();

  register<M extends MethodName>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler as AnyHandler);
  }

  async dispatch(method: string, rawParams: unknown, ctx: DispatchContext): Promise<unknown> {
    if (!(method in registry)) {
      throw new ProtocolError(ErrorCode.unknown_method, `unknown method: ${method}`);
    }
    const entry = registry[method as MethodName];
    const parsed = entry.params.safeParse(rawParams ?? {});
    if (!parsed.success) {
      throw new ProtocolError(ErrorCode.invalid_params, `invalid params for ${method}`, {
        issues: parsed.error.issues,
      });
    }
    if (!ctx.authenticator.authorized(ctx.grant, method)) {
      throw new ProtocolError(ErrorCode.forbidden, `not authorized for ${method}`);
    }
    const handler = this.handlers.get(method as MethodName);
    if (!handler) {
      throw new ProtocolError(ErrorCode.unknown_method, `no handler for ${method}`);
    }
    return handler(parsed.data, ctx);
  }
}
