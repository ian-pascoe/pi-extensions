import type { Usage } from "@earendil-works/pi-ai";

/** Add two optional Pi usage totals without retaining mutable references to either input. */
export function addMinimalSubagentsUsage(
  left: Usage | undefined,
  right: Usage | undefined,
): Usage | undefined {
  if (!left) return right ? structuredClone(right) : undefined;
  if (!right) return structuredClone(left);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
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
