import { describe, expect, test } from "vitest";
import { LruCache } from "../src/lru-cache.js";

describe("LruCache", () => {
  test("evicts the oldest entry when over capacity", () => {
    const cache = new LruCache<string, string>(2);

    cache.set("a", "first");
    cache.set("b", "second");
    cache.set("c", "third");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("second");
    expect(cache.get("c")).toBe("third");
  });

  test("refreshes recency when an entry is read", () => {
    const cache = new LruCache<string, string>(2);

    cache.set("a", "first");
    cache.set("b", "second");
    expect(cache.get("a")).toBe("first");
    cache.set("c", "third");

    expect(cache.get("a")).toBe("first");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("third");
  });
});
