/**
 * Per-key mutual exclusion. Each key has at most one in-flight critical
 * section at a time; additional callers queue behind it. Used to serialize
 * writes to a single task list so concurrent subagents cannot clobber each
 * other's claim/complete mutations.
 */
export class KeyedMutex<K> {
  private readonly tails: Map<K, Promise<unknown>> = new Map();

  async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, next);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      // If nobody else queued behind us, drop the entry so the map doesn't grow.
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
