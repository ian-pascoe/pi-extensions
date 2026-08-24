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
  it("aggregates every token and cost field", () => {
    expect(addMinimalSubagentsUsage(usage(2), usage(3))).toEqual(usage(5));
  });
});
