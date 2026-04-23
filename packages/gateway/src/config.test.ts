import { describe, it, expect } from "vitest";
import { configSchema } from "./config.js";

describe("config.chat.delivery parsing", () => {
  it("defaults to interrupt when chat is omitted", () => {
    const c = configSchema.parse({});
    expect(c.chat.delivery.mode).toBe("interrupt");
    expect(c.chat.delivery.max_queued).toBe(50);
    expect(c.chat.delivery.collapse_duplicates).toBe(true);
  });

  it("accepts shorthand: chat.delivery as a string", () => {
    const c = configSchema.parse({ chat: { delivery: "queue" } });
    expect(c.chat.delivery.mode).toBe("queue");
    expect(c.chat.delivery.max_queued).toBe(50);
  });

  it("accepts shorthand: chat.delivery_mode as a string", () => {
    const c = configSchema.parse({ chat: { delivery_mode: "queue" } });
    expect(c.chat.delivery.mode).toBe("queue");
  });

  it("accepts full object form with tuning knobs", () => {
    const c = configSchema.parse({
      chat: {
        delivery: {
          mode: "queue",
          max_queued: 10,
          collapse_duplicates: false,
        },
      },
    });
    expect(c.chat.delivery.mode).toBe("queue");
    expect(c.chat.delivery.max_queued).toBe(10);
    expect(c.chat.delivery.collapse_duplicates).toBe(false);
  });

  it("rejects unknown delivery modes with a readable error", () => {
    expect(() => configSchema.parse({ chat: { delivery: "blast" } })).toThrow();
  });

  it("rejects max_queued > 1000", () => {
    expect(() =>
      configSchema.parse({ chat: { delivery: { max_queued: 10_000 } } }),
    ).toThrow();
  });
});
