import { describe, expect, test } from "vitest";
import { configDefaults, parseAdaptiveThinkingConfig } from "../src/config.js";

describe("parseAdaptiveThinkingConfig", () => {
  test("rejects invalid config types", () => {
    expect(() => parseAdaptiveThinkingConfig({ enabled: "yes" })).toThrow();
  });

  test("rejects additional config properties", () => {
    expect(() => parseAdaptiveThinkingConfig({ unknown: true })).toThrow();
  });

  test("normalizes the deprecated systemPrompt alias to guidance", () => {
    expect(parseAdaptiveThinkingConfig({ systemPrompt: "Legacy guidance" }).config).toEqual({
      ...configDefaults,
      guidance: "Legacy guidance",
    });
  });

  test("rejects guidance together with its deprecated alias", () => {
    expect(() =>
      parseAdaptiveThinkingConfig({ guidance: "New guidance", systemPrompt: "Legacy guidance" }),
    ).toThrow("cannot contain both guidance and systemPrompt");
  });

  test("rejects duplicate setter and status tool names", () => {
    expect(() => parseAdaptiveThinkingConfig({ statusToolName: "set_thinking_level" })).toThrow(
      "toolName and statusToolName must be different",
    );
  });
});
