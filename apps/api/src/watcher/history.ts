/**
 * Sliding-window call counter per sender, used by the rapid-repeat rule.
 * Memory is bounded: stale timestamps are pruned and the oldest senders evicted.
 */
export class SenderHistory {
  readonly #windowMs: number;
  readonly #maxSenders: number;
  readonly #calls = new Map<string, number[]>();

  constructor(windowSec: number, maxSenders = 10_000) {
    this.#windowMs = windowSec * 1_000;
    this.#maxSenders = maxSenders;
  }

  /** Records a call at `nowMs` and returns how many calls fall inside the window. */
  record(sender: string, nowMs: number): number {
    const key = sender.toLowerCase();
    const cutoff = nowMs - this.#windowMs;
    const recent = (this.#calls.get(key) ?? []).filter((t) => t > cutoff);
    recent.push(nowMs);
    // Re-insert so Map order tracks recency for eviction.
    this.#calls.delete(key);
    this.#calls.set(key, recent);
    if (this.#calls.size > this.#maxSenders) {
      const oldest = this.#calls.keys().next().value;
      if (oldest !== undefined) this.#calls.delete(oldest);
    }
    return recent.length;
  }

  reset(): void {
    this.#calls.clear();
  }

  get size(): number {
    return this.#calls.size;
  }
}

/** Fixed-capacity set that forgets the oldest entries first. */
export class BoundedSet {
  readonly #items = new Set<string>();

  constructor(private readonly capacity: number) {}

  /** Adds `item`; returns false if it was already present. */
  add(item: string): boolean {
    if (this.#items.has(item)) return false;
    this.#items.add(item);
    if (this.#items.size > this.capacity) {
      const oldest = this.#items.values().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.#items.clear();
  }
}
