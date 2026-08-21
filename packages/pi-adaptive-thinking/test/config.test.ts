import { describe, expect, test } from "vitest";
import { configDefaults, defaultGuidance, parseAdaptiveThinkingConfig } from "../src/config.js";

describe("parseAdaptiveThinkingConfig", () => {
  test("uses defaults when input is undefined", () => {
    expect(parseAdaptiveThinkingConfig(undefined).config).toEqual(configDefaults);
  });

  test("merges partial config with defaults", () => {
    expect(parseAdaptiveThinkingConfig({ toolName: "think_harder" }).config).toEqual({
      ...configDefaults,
      toolName: "think_harder",
    });
  });

  test("rejects invalid config types", () => {
    expect(() => parseAdaptiveThinkingConfig({ enabled: "yes" })).toThrow();
  });

  test("rejects additional config properties", () => {
    expect(() => parseAdaptiveThinkingConfig({ unknown: true })).toThrow();
  });

  test("default guidance requires active thinking-level management", () => {
    expect(defaultGuidance).toContain("manage thinking level actively");
    expect(defaultGuidance).toContain("NEVER leave the current level unchanged by inertia");
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
