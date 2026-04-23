import { describe, it, expect } from "vitest";
import { parseFrame, parseFrameString } from "./frames.js";
import { ProtocolError, ErrorCode } from "./errors.js";

describe("parseFrame", () => {
  it("accepts a request frame", () => {
    const frame = parseFrame({ type: "request", id: "abc", method: "chat.send", params: {} });
    expect(frame.type).toBe("request");
    if (frame.type === "request") expect(frame.method).toBe("chat.send");
  });

  it("accepts a successful response frame", () => {
    const frame = parseFrame({ type: "response", id: "abc", ok: true, result: { ok: true } });
    expect(frame.type).toBe("response");
  });

  it("accepts an error response frame", () => {
    const frame = parseFrame({
      type: "response",
      id: "abc",
      ok: false,
      error: { code: "internal_error", message: "boom" },
    });
    expect(frame.type).toBe("response");
  });

  it("accepts event and subscribe frames", () => {
    expect(parseFrame({ type: "event", topic: "chat.text_delta", data: {} }).type).toBe("event");
    expect(
      parseFrame({ type: "subscribe", id: "1", topics: ["chat.*/x"] }).type,
    ).toBe("subscribe");
  });

  it("rejects unknown frame types", () => {
    try {
      parseFrame({ type: "gibberish" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(ErrorCode.invalid_frame);
    }
  });

  it("turns JSON parse errors into parse_error", () => {
    try {
      parseFrameString("{ not json");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as ProtocolError).code).toBe(ErrorCode.parse_error);
    }
  });
});
