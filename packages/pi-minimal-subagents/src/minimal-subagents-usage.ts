import type { Usage } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { RenderUsageSchema } from "./minimal-subagents-render-contract.js";

/** Return a clone with optional counters present, so every reported usage has one shape. */
export function normalizeMinimalSubagentsUsage(usage: Usage): Usage {
  return {
    ...structuredClone(usage),
    cacheWrite1h: usage.cacheWrite1h ?? 0,
    reasoning: usage.reasoning ?? 0,
  };
}

/** Add two optional Pi usage totals without retaining mutable references to either input. */
export function addMinimalSubagentsUsage(
  left: Usage | undefined,
  right: Usage | undefined,
): Usage | undefined {
  if (!left) return right ? normalizeMinimalSubagentsUsage(right) : undefined;
  if (!right) return normalizeMinimalSubagentsUsage(left);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
    reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

/**
 * USD decimal places kept in model-visible and structured usage costs. Six places is one
 * millionth of a dollar: finer than any single turn's cost is worth reading, yet coarse enough to
 * drop the binary-float tails that summing many per-message costs produces.
 */
export const MINIMAL_SUBAGENTS_COST_DECIMALS = 6;

const COST_SCALE = 10 ** MINIMAL_SUBAGENTS_COST_DECIMALS;

function roundCost(value: number): number {
  return Number.isFinite(value) ? Math.round(value * COST_SCALE) / COST_SCALE : value;
}

/**
 * Return a clone whose cost fields are rounded for presentation. Each field rounds independently
 * from its exact value, so `total` stays within half a unit per summed field of the rounded sum.
 */
export function roundMinimalSubagentsUsageCosts(usage: Usage): Usage {
  return {
    ...usage,
    cost: {
      input: roundCost(usage.cost.input),
      output: roundCost(usage.cost.output),
      cacheRead: roundCost(usage.cost.cacheRead),
      cacheWrite: roundCost(usage.cost.cacheWrite),
      total: roundCost(usage.cost.total),
    },
  };
}

/** Every value `JSON.stringify` can hand to a replacer. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Serialize a tool result to JSON with every nested `usage` cost rounded for presentation. Exact
 * values stay in the Registry and session data, which never pass through here.
 */
export function stringifyMinimalSubagentsResult<T>(result: T, space?: number): string {
  return JSON.stringify(
    result,
    (key, value: JsonValue) =>
      key === "usage" && Value.Check(RenderUsageSchema, value)
        ? roundMinimalSubagentsUsageCosts(value)
        : value,
    space,
  );
}
