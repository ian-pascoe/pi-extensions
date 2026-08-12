import { describe, expect, test } from "vitest";
import { isThinkingLevel, resolveSupportedThinkingLevels } from "../src/thinking-levels.js";

describe("thinking level helpers", () => {
  test("recognizes valid Pi thinking levels", () => {
    expect(isThinkingLevel("off")).toBe(true);
    expect(isThinkingLevel("minimal")).toBe(true);
    expect(isThinkingLevel("low")).toBe(true);
    expect(isThinkingLevel("medium")).toBe(true);
    expect(isThinkingLevel("high")).toBe(true);
    expect(isThinkingLevel("xhigh")).toBe(true);
    expect(isThinkingLevel("max")).toBe(true);
    expect(isThinkingLevel("turbo")).toBe(false);
  });

  test("uses fallback levels when model is undefined", () => {
    expect(resolveSupportedThinkingLevels(undefined)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("uses model thinkingLevelMap null entries to remove unsupported levels", () => {
    expect(
      resolveSupportedThinkingLevels({
        id: "model",
        name: "Model",
        api: "openai-completions",
        provider: "provider",
        baseUrl: "https://example.com",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          high: "high",
          xhigh: "max",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
      }),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
