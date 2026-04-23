import { describe, it, expect } from "vitest";
import { DeliveryQueue, renderDrainAsUserBlock, type QueuedMessage } from "./queue.js";

function msg(id: string, sessionId: string, text: string, enqueuedAt = Date.now()): QueuedMessage {
  return {
    id,
    sessionId,
    content: [{ type: "text", text }],
    enqueuedAt,
  };
}

describe("DeliveryQueue", () => {
  it("enqueue reports queue position", () => {
    const q = new DeliveryQueue({ maxQueued: 10, collapseDuplicates: false });
    expect(q.enqueue(msg("1", "s", "hi")).position).toBe(1);
    expect(q.enqueue(msg("2", "s", "there")).position).toBe(2);
    expect(q.size("s")).toBe(2);
  });

  it("scopes queues by session", () => {
    const q = new DeliveryQueue({ maxQueued: 10, collapseDuplicates: false });
    q.enqueue(msg("1", "a", "x"));
    q.enqueue(msg("2", "b", "y"));
    expect(q.size("a")).toBe(1);
    expect(q.size("b")).toBe(1);
    expect(q.size("c")).toBe(0);
  });

  it("drainAll empties and returns the full list", () => {
    const q = new DeliveryQueue({ maxQueued: 10, collapseDuplicates: false });
    q.enqueue(msg("1", "s", "a"));
    q.enqueue(msg("2", "s", "b"));
    const drained = q.drainAll("s");
    expect(drained.map((m) => m.id)).toEqual(["1", "2"]);
    expect(q.size("s")).toBe(0);
  });

  it("drainAll on empty session returns []", () => {
    const q = new DeliveryQueue({ maxQueued: 10, collapseDuplicates: false });
    expect(q.drainAll("missing")).toEqual([]);
  });

  it("drainOne pops in FIFO order and returns null when empty", () => {
    const q = new DeliveryQueue({ maxQueued: 10, collapseDuplicates: false });
    q.enqueue(msg("1", "s", "a"));
    q.enqueue(msg("2", "s", "b"));
    expect(q.drainOne("s")?.id).toBe("1");
    expect(q.drainOne("s")?.id).toBe("2");
    expect(q.drainOne("s")).toBeNull();
  });

  it("evicts oldest messages when maxQueued is exceeded", () => {
    const q = new DeliveryQueue({ maxQueued: 2, collapseDuplicates: false });
    q.enqueue(msg("1", "s", "a"));
    q.enqueue(msg("2", "s", "b"));
    const third = q.enqueue(msg("3", "s", "c"));
    expect(third.dropped).toBe(true);
    expect(q.peek("s").map((m) => m.id)).toEqual(["2", "3"]);
  });

  it("peek returns the current snapshot without mutating", () => {
    const q = new DeliveryQueue({ maxQueued: 10, collapseDuplicates: false });
    q.enqueue(msg("1", "s", "a"));
    const snap = q.peek("s");
    expect(snap.map((m) => m.id)).toEqual(["1"]);
    expect(q.size("s")).toBe(1);
  });
});

describe("renderDrainAsUserBlock", () => {
  it("returns empty string for empty input", () => {
    expect(renderDrainAsUserBlock([])).toBe("");
  });

  it("labels the batch and numbers each queued entry", () => {
    const now = Date.now();
    const rendered = renderDrainAsUserBlock([
      msg("1", "s", "hi there", now - 2000),
      msg("2", "s", "again", now - 500),
    ]);
    expect(rendered).toContain("New messages arrived");
    expect(rendered).toContain("queued #1");
    expect(rendered).toContain("queued #2");
    expect(rendered).toContain("hi there");
    expect(rendered).toContain("again");
  });
});
