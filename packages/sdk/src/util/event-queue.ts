/**
 * Single-producer, single-consumer async queue. Used to interleave
 * superconnector-side events (e.g. approval decisions) into a message stream.
 */
export class EventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) {
      return Promise.resolve({ value: this.items.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
