import type { Usage } from "@earendil-works/pi-ai";

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
