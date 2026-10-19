interface QueuedRequest {
  readonly grant: () => void;
}

/**
 * Cap how many tasks run at once, queueing the rest first in, first out. A queued task leaves the
 * queue, without ever starting, when its signal aborts.
 */
export class LspRequestLimiter {
  private active = 0;
  private readonly queue: QueuedRequest[] = [];

  /**
   * @param limit Most tasks running at once; a positive integer.
   * @param abortError Builds the rejection for a task whose signal aborts before it starts.
   */
  constructor(
    private readonly limit: number,
    private readonly abortError: () => Error,
  ) {}

  /** Wait for a free slot, run `task` holding it, and release it when `task` settles. */
  async run<TResult>(
    signal: AbortSignal | undefined,
    task: () => Promise<TResult>,
  ): Promise<TResult> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(this.abortError());
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const request: QueuedRequest = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.queue.splice(this.queue.indexOf(request), 1);
        reject(this.abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(request);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    // A granted slot passes straight to the next request, so `active` stays unchanged.
    if (next === undefined) this.active--;
    else next.grant();
  }
}
