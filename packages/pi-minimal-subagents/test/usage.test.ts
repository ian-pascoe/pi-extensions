import { describe, expect, it } from "vitest";
import {
  addMinimalSubagentsUsage,
  normalizeMinimalSubagentsUsage,
} from "../src/minimal-subagents-usage.js";

const usage = (value: number) => ({
  input: value,
  output: value,
  cacheRead: value,
  cacheWrite: value,
  cacheWrite1h: value,
  reasoning: value,
  totalTokens: value,
  cost: { input: value, output: value, cacheRead: value, cacheWrite: value, total: value },
});

describe("minimal subagents usage", () => {
  it("aggregates every token and cost field", () => {
    expect(addMinimalSubagentsUsage(usage(2), usage(3))).toEqual(usage(5));
  });

  it("reports optional counters as zero so every usage has one shape", () => {
    const { cacheWrite1h: _cacheWrite1h, reasoning: _reasoning, ...minimal } = usage(2);
    const expected = { ...usage(2), cacheWrite1h: 0, reasoning: 0 };
    expect(normalizeMinimalSubagentsUsage(minimal)).toEqual(expected);
    expect(addMinimalSubagentsUsage(undefined, minimal)).toEqual(expected);
    expect(addMinimalSubagentsUsage(minimal, minimal)).toEqual({
      ...usage(4),
      cacheWrite1h: 0,
      reasoning: 0,
    });
  });
});
