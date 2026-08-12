import { describe, expect, it } from "vitest";
import {
  formatSubagentDuration,
  formatSubagentPreview,
  formatSubagentTokenCount,
  formatSubagentUsage,
} from "../src/minimal-subagents-rendering.js";

describe("minimal subagents rendering", () => {
  it("formats bounded previews, durations, token counts, and usage summaries", () => {
    expect(formatSubagentDuration(undefined)).toBeUndefined();
    expect(formatSubagentDuration(1_500)).toBe("1s");
    expect(formatSubagentDuration(61_000)).toBe("1m 01s");
    expect(formatSubagentTokenCount(1_200)).toBe("1.2k");
    expect(formatSubagentPreview("  one\n two   three ", 10)).toBe("one two t…");
    expect(
      formatSubagentUsage({
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
      }),
    ).toContain("total 120");
  });
});
