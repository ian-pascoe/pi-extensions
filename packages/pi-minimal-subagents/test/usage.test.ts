import { describe, expect, it } from "vitest";
import {
  addMinimalSubagentsUsage,
  MINIMAL_SUBAGENTS_COST_DECIMALS,
  normalizeMinimalSubagentsUsage,
  roundMinimalSubagentsUsageCosts,
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

  describe("presentation rounding", () => {
    const parts = {
      input: 0.000022999999999999997,
      output: 0.0018,
      cacheRead: 0.0000012345678,
      cacheWrite: 0.011296249999999999,
    };
    const noisy = {
      ...usage(1),
      cost: {
        ...parts,
        total: parts.input + parts.output + parts.cacheRead + parts.cacheWrite,
      },
    };
    const decimals = (value: number) => value.toString().split(".")[1]?.length ?? 0;

    it("rounds every cost field to fixed USD precision without float-noise tails", () => {
      const { cost } = roundMinimalSubagentsUsageCosts(noisy);
      expect(cost).toEqual({
        input: 0.000023,
        output: 0.0018,
        cacheRead: 0.000001,
        cacheWrite: 0.011296,
        total: 0.01312,
      });
      for (const value of [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total]) {
        expect(decimals(value)).toBeLessThanOrEqual(MINIMAL_SUBAGENTS_COST_DECIMALS);
      }
    });

    it("preserves a non-finite cost while still rounding the others", () => {
      const odd = { ...usage(1), cost: { ...noisy.cost, total: Number.NaN } };
      const { cost } = roundMinimalSubagentsUsageCosts(odd);
      expect(cost.total).toBeNaN();
      expect(cost.input).toBe(0.000023);
    });
  });
});
