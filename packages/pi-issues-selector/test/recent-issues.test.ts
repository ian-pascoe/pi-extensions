import { describe, expect, test } from "vitest";
import type { IssueListing } from "../src/github-host.js";
import { RecentIssues } from "../src/recent-issues.js";

const listing = (...numbers: number[]): IssueListing => ({
  ok: true,
  issues: numbers.map((number) => ({
    number,
    title: `Issue ${number}`,
    kind: "issue",
    state: "open",
  })),
});
const failure: IssueListing = { ok: false, reason: "unavailable" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RecentIssues", () => {
  test("serves a loaded listing until it expires", async () => {
    let now = 1_000;
    let loads = 0;
    const cache = new RecentIssues({ now: () => now, ttlMs: 300_000 });
    const load = async (): Promise<IssueListing> => listing(++loads);
    const signal = new AbortController().signal;
    expect(await cache.get("a", load, signal)).toEqual(listing(1));
    now += 299_999;
    expect(await cache.get("a", load, signal)).toEqual(listing(1));
    now += 1;
    expect(await cache.get("a", load, signal)).toEqual(listing(2));
    expect(await cache.get("b", load, signal)).toEqual(listing(3));
  });

  test("remembers a failure briefly so a missing gh is not spawned on every keystroke", async () => {
    let now = 0;
    let loads = 0;
    const cache = new RecentIssues({ now: () => now, failureTtlMs: 30_000 });
    const load = async (): Promise<IssueListing> => (++loads === 1 ? failure : listing(2));
    const signal = new AbortController().signal;
    expect(await cache.get("a", load, signal)).toEqual(failure);
    now += 29_999;
    expect(await cache.get("a", load, signal)).toEqual(failure);
    now += 1;
    expect(await cache.get("a", load, signal)).toEqual(listing(2));
  });

  test("shares one load between concurrent callers", async () => {
    const gate = deferred<IssueListing>();
    let loads = 0;
    const cache = new RecentIssues();
    const load = (): Promise<IssueListing> => {
      loads++;
      return gate.promise;
    };
    const signal = new AbortController().signal;
    const first = cache.get("a", load, signal);
    const second = cache.get("a", load, signal);
    gate.resolve(listing(1));
    expect(await Promise.all([first, second])).toEqual([listing(1), listing(1)]);
    expect(loads).toBe(1);
  });

  test("returns undefined to a cancelled caller at once while the load goes on for another", async () => {
    const gate = deferred<IssueListing>();
    const cache = new RecentIssues({ cancelGraceMs: 0 });
    let loadSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal): Promise<IssueListing> => {
      loadSignal = signal;
      return gate.promise;
    };
    const cancelled = new AbortController();
    const staying = new AbortController();
    const first = cache.get("a", load, cancelled.signal);
    const second = cache.get("a", load, staying.signal);
    cancelled.abort();
    expect(await first).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(loadSignal?.aborted).toBe(false);
    gate.resolve(listing(1));
    expect(await second).toEqual(listing(1));
  });

  test("cancels the load once every caller left, and does not cache the cancelled result", async () => {
    const cache = new RecentIssues({ cancelGraceMs: 0 });
    const signals: AbortSignal[] = [];
    const load = (signal: AbortSignal): Promise<IssueListing> => {
      signals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(failure), { once: true });
      });
    };
    const leaving = new AbortController();
    const pending = cache.get("a", load, leaving.signal);
    leaving.abort();
    expect(await pending).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signals[0]?.aborted).toBe(true);
    expect(await cache.get("a", async () => listing(9), new AbortController().signal)).toEqual(
      listing(9),
    );
  });

  test("keeps the load running when a new caller arrives within the grace period", async () => {
    const gate = deferred<IssueListing>();
    const cache = new RecentIssues({ cancelGraceMs: 50 });
    let loads = 0;
    let loadSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal): Promise<IssueListing> => {
      loads++;
      loadSignal = signal;
      return gate.promise;
    };
    const typed = new AbortController();
    const first = cache.get("a", load, typed.signal);
    typed.abort();
    expect(await first).toBeUndefined();
    const next = cache.get("a", load, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(loadSignal?.aborted).toBe(false);
    gate.resolve(listing(1));
    expect(await next).toEqual(listing(1));
    expect(loads).toBe(1);
  });

  test("returns undefined at once for a request that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await new RecentIssues().get("a", async () => listing(1), controller.signal)).toBe(
      undefined,
    );
  });
});
