import type { EventFrame } from "@squad/protocol";

export interface Subscriber {
  send(frame: EventFrame): void;
  id: string;
}

/**
 * Simple topic-based pub/sub. Topics are strings; subscribers match by
 * exact topic or by prefix (`"chat.*"` covers `"chat.text_delta"`).
 */
export class Broadcast {
  private readonly subscriptions: Map<string, Set<Subscriber>> = new Map();

  subscribe(sub: Subscriber, topic: string): void {
    let set = this.subscriptions.get(topic);
    if (!set) {
      set = new Set();
      this.subscriptions.set(topic, set);
    }
    set.add(sub);
  }

  unsubscribe(sub: Subscriber, topic: string): void {
    const set = this.subscriptions.get(topic);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscriptions.delete(topic);
  }

  /** Remove this subscriber from every topic. Call on socket close. */
  removeAll(sub: Subscriber): void {
    for (const [topic, set] of this.subscriptions) {
      set.delete(sub);
      if (set.size === 0) this.subscriptions.delete(topic);
    }
  }

  publish(topic: string, data: unknown): void {
    const frame: EventFrame = { type: "event", topic, data };
    // Exact-topic subscribers.
    this.subscriptions.get(topic)?.forEach((s) => s.send(frame));
    // Prefix subscribers: e.g. a subscriber to "chat.*" sees any "chat.<anything>"
    // topic; a subscriber to "chat.*/sess-123" sees "chat.<anything>/sess-123".
    for (const [subTopic, subs] of this.subscriptions) {
      if (!subTopic.includes("*")) continue;
      if (matchWildcard(subTopic, topic)) {
        subs.forEach((s) => s.send(frame));
      }
    }
  }
}

function matchWildcard(pattern: string, topic: string): boolean {
  // Convert "chat.*/sess-123" → /^chat\.[^/]+\/sess-123$/
  // `*` matches any run of characters that aren't `/` (the topic-scope separator).
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\*]/g, "\\$&")
        .replace(/\\\*/g, "[^/]+") +
      "$",
  );
  return regex.test(topic);
}
