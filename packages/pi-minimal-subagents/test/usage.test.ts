import { describe, expect, it } from "vitest";
import { addMinimalSubagentsUsage } from "../src/minimal-subagents-usage.js";

const usage = (value: number) => ({
  input: value,
  output: value,
  cacheRead: value,
  cacheWrite: value,
  totalTokens: value,
  cost: { input: value, output: value, cacheRead: value, cacheWrite: value, total: value },
});

describe("minimal subagents usage", () => {
  it("clones one optional total instead of retaining its mutable reference", () => {
    const source = usage(2);
    const cloned = addMinimalSubagentsUsage(undefined, source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned?.cost).not.toBe(source.cost);
    expect(addMinimalSubagentsUsage(undefined, undefined)).toBeUndefined();
  });

  it("aggregates every token and cost field", () => {
    expect(addMinimalSubagentsUsage(usage(2), usage(3))).toEqual(usage(5));
  });
});
