/**
 * A FIFO counting semaphore with cancellation. Waiters are woken in arrival
 * order by an explicit queue — nothing polls — and an aborted waiter leaves the
 * queue instead of holding a place in it.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (err: Error) => void; signal?: AbortSignal; onAbort: () => void }> = [];

  constructor(private readonly capacity: () => number) {}

  get active(): number {
    return this.inFlight;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  get limit(): number {
    return Math.max(1, this.capacity());
  }

  /** Resolves with a release function; call it exactly once. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    if (this.inFlight < this.limit && this.waiters.length === 0) {
      this.inFlight++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => resolve(this.releaser()),
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("cancelled"));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.inFlight < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.signal?.removeEventListener("abort", next.onAbort);
      this.inFlight++;
      next.resolve();
    }
  }
}
