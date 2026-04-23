import { describe, it, expect } from "vitest";
import { Broadcast, type Subscriber } from "./broadcast.js";
import type { EventFrame } from "@squad/protocol";

function makeSub(): { sub: Subscriber; received: EventFrame[] } {
  const received: EventFrame[] = [];
  return {
    received,
    sub: {
      id: `sub-${Math.random()}`,
      send: (f) => received.push(f),
    },
  };
}

describe("Broadcast", () => {
  it("delivers exact-topic events to subscribers", () => {
    const b = new Broadcast();
    const { sub, received } = makeSub();
    b.subscribe(sub, "chat.text_delta/s1");
    b.publish("chat.text_delta/s1", { delta: "hi" });
    expect(received).toHaveLength(1);
    expect(received[0]!.topic).toBe("chat.text_delta/s1");
  });

  it("delivers wildcard-topic events scoped by session suffix", () => {
    const b = new Broadcast();
    const { sub, received } = makeSub();
    b.subscribe(sub, "chat.*/s1");
    b.publish("chat.text_delta/s1", { delta: "hi" });
    b.publish("chat.assistant_message/s1", {});
    b.publish("chat.text_delta/s2", { delta: "no" }); // other session — should not match
    expect(received).toHaveLength(2);
    expect(received[0]!.topic).toBe("chat.text_delta/s1");
    expect(received[1]!.topic).toBe("chat.assistant_message/s1");
  });

  it("removes all subscriptions on removeAll", () => {
    const b = new Broadcast();
    const { sub, received } = makeSub();
    b.subscribe(sub, "a");
    b.subscribe(sub, "b.*");
    b.removeAll(sub);
    b.publish("a", {});
    b.publish("b.c", {});
    expect(received).toHaveLength(0);
  });
});
