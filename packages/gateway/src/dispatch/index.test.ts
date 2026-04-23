import { describe, it, expect } from "vitest";
import { Dispatcher, type DispatchContext } from "./index.js";
import { Authenticator } from "../auth.js";
import { ErrorCode, ProtocolError } from "@squad/protocol";

function ctx(scopes: string[] = ["*"]): DispatchContext {
  return {
    grant: { label: "t", scopes },
    authenticator: new Authenticator([]),
    subscriberId: "sub1",
  };
}

describe("Dispatcher", () => {
  it("throws unknown_method for methods not in the registry", async () => {
    const d = new Dispatcher();
    await expect(d.dispatch("does.not.exist", {}, ctx())).rejects.toMatchObject({
      code: ErrorCode.unknown_method,
    });
  });

  it("validates params via zod and raises invalid_params on failure", async () => {
    const d = new Dispatcher();
    d.register("chat.history", async () => ({ messages: [] }));
    // chat.history requires sessionId: string — pass a number.
    await expect(d.dispatch("chat.history", { sessionId: 123 }, ctx())).rejects.toMatchObject({
      code: ErrorCode.invalid_params,
    });
  });

  it("enforces authorization before calling the handler", async () => {
    const d = new Dispatcher();
    let called = false;
    d.register("chat.history", async () => {
      called = true;
      return { messages: [] };
    });
    await expect(d.dispatch("chat.history", { sessionId: "s" }, ctx(["admin.*"]))).rejects.toMatchObject(
      { code: ErrorCode.forbidden },
    );
    expect(called).toBe(false);
  });

  it("raises unknown_method when method is in the registry but no handler is bound", async () => {
    const d = new Dispatcher();
    await expect(d.dispatch("chat.history", { sessionId: "s" }, ctx())).rejects.toMatchObject({
      code: ErrorCode.unknown_method,
    });
  });

  it("calls the handler with parsed params (including defaults) and passes ctx through", async () => {
    const d = new Dispatcher();
    d.register("chat.history", async (params, dctx) => {
      // Zod fills in the default `limit: 100`.
      expect(params.sessionId).toBe("s1");
      expect(params.limit).toBe(100);
      expect(dctx.grant.label).toBe("t");
      return { messages: [] };
    });
    const result = await d.dispatch("chat.history", { sessionId: "s1" }, ctx());
    expect(result).toEqual({ messages: [] });
  });

  it("ProtocolError exposes code and data", () => {
    const err = new ProtocolError(ErrorCode.invalid_params, "nope", { why: "bad" });
    expect(err.code).toBe(ErrorCode.invalid_params);
    expect(err.data).toEqual({ why: "bad" });
  });
});
