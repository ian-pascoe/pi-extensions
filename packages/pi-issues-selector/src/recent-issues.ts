import type { IssueListing } from "./issue-host.js";

export interface RecentIssuesOptions {
  now?: () => number;
  /** How long a loaded listing is served. */
  ttlMs?: number;
  /** How long a failed load is remembered, so a missing `gh` is not spawned on every keystroke. */
  failureTtlMs?: number;
  /** How long a load runs on after its last caller left, for the next keystroke to join it. */
  cancelGraceMs?: number;
}

interface Load {
  controller: AbortController;
  promise: Promise<IssueListing | undefined>;
  waiters: number;
  cancelTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Entry {
  listing: IssueListing;
  expiresAt: number;
}

/**
 * Recent issues per repository, in memory. One load serves every caller that asks while it runs;
 * a caller that is cancelled gets its answer at once, and the load is cancelled only when nobody
 * is left waiting for it.
 */
export class RecentIssues {
  private readonly entries = new Map<string, Entry>();
  private readonly loads = new Map<string, Load>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly cancelGraceMs: number;

  constructor(options: RecentIssuesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 30_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 1_000;
  }

  /** The listing for `key`, or undefined when `signal` aborted first. */
  async get(
    key: string,
    load: (signal: AbortSignal) => Promise<IssueListing>,
    signal: AbortSignal,
  ): Promise<IssueListing | undefined> {
    if (signal.aborted) return undefined;
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.listing;
    const running = this.loads.get(key) ?? this.start(key, load);
    clearTimeout(running.cancelTimer);
    running.cancelTimer = undefined;
    running.waiters++;
    try {
      return await new Promise<IssueListing | undefined>((resolve) => {
        const abandon = (): void => resolve(undefined);
        signal.addEventListener("abort", abandon, { once: true });
        void running.promise.then((listing) => {
          signal.removeEventListener("abort", abandon);
          resolve(listing);
        });
      });
    } finally {
      running.waiters--;
      if (running.waiters === 0 && this.loads.get(key) === running) this.scheduleCancel(running);
    }
  }

  private start(key: string, load: (signal: AbortSignal) => Promise<IssueListing>): Load {
    const controller = new AbortController();
    const running: Load = {
      controller,
      waiters: 0,
      cancelTimer: undefined,
      promise: load(controller.signal).then(
        (listing) => this.finish(key, running, listing),
        () => this.finish(key, running, { ok: false, reason: "unavailable" }),
      ),
    };
    this.loads.set(key, running);
    return running;
  }

  private finish(key: string, running: Load, listing: IssueListing): IssueListing | undefined {
    clearTimeout(running.cancelTimer);
    if (this.loads.get(key) === running) this.loads.delete(key);
    // A cancelled load says nothing about the repository, so it is not remembered.
    if (running.controller.signal.aborted) return undefined;
    const ttl = listing.ok ? this.ttlMs : this.failureTtlMs;
    this.entries.set(key, { listing, expiresAt: this.now() + ttl });
    return listing;
  }

  private scheduleCancel(running: Load): void {
    running.cancelTimer = setTimeout(() => {
      running.controller.abort();
    }, this.cancelGraceMs);
    running.cancelTimer.unref();
  }
}
