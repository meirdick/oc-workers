// In-DO serial queue (cf-orbs orb/exclusive.ts, via the spike). DO input gates do not serialize across
// awaits on container calls, so every op and every settle handler runs through one queue.

export class ExclusiveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** Run fn after every earlier fn settles. A rejection reaches only its own caller. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const p = this.tail.then(fn).finally(() => {
      this.depth--;
    });
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Jobs queued or running. */
  get pending(): number {
    return this.depth;
  }
}
