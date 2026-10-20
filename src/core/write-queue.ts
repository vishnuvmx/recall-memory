/**
 * Concurrency-safe serialized write queue and mutex for Node.js.
 * Ensures transactions and filesystem writes are serialized sequentially,
 * preventing SQLite write lock collisions (SQLITE_BUSY) and file races.
 */
export class AsyncWriteQueue {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /**
   * Enqueues an asynchronous write operation to run after all currently pending writes finish.
   */
  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    this.pendingCount++;
    const run = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        this.pendingCount--;
      }
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  get pending(): number {
    return this.pendingCount;
  }

  async drain(): Promise<void> {
    await this.queue;
  }
}

export const globalWriteQueue = new AsyncWriteQueue();

/**
 * Execute an operation with retry logic for handling transient database lock errors.
 */
export async function withRetry<T>(
  operation: () => Promise<T> | T,
  maxRetries = 5,
  initialDelayMs = 50,
): Promise<T> {
  let attempt = 0;
  let delay = initialDelayMs;

  for (;;) {
    try {
      return await operation();
    } catch (err: unknown) {
      attempt++;
      const msg = (err as Error).message || '';
      const isLockError =
        msg.includes('busy') ||
        msg.includes('locked') ||
        msg.includes('SQLITE_BUSY') ||
        msg.includes('EBUSY') ||
        msg.includes('EPERM');

      if (!isLockError || attempt >= maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter
      const jitter = Math.floor(Math.random() * delay * 0.5);
      const sleepMs = delay + jitter;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      delay = Math.min(delay * 2, 1000);
    }
  }
}
