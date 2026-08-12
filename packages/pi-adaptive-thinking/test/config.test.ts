import { describe, expect, test } from "vitest";
import { configDefaults, defaultGuidance, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  test("uses defaults when input is undefined", () => {
    expect(parseConfig(undefined)).toEqual(configDefaults);
  });

  test("merges partial config with defaults", () => {
    expect(parseConfig({ toolName: "think_harder" })).toEqual({
      ...configDefaults,
      toolName: "think_harder",
    });
  });

  test("rejects invalid config types", () => {
    expect(() => parseConfig({ enabled: "yes" })).toThrow();
  });

  test("rejects additional config properties", () => {
    expect(() => parseConfig({ unknown: true })).toThrow();
  });

  test("default guidance requires active thinking-level management", () => {
    expect(defaultGuidance).toContain("manage thinking level actively");
    expect(defaultGuidance).toContain("NEVER leave the current level unchanged by inertia");
  });

  test("normalizes the deprecated systemPrompt alias to guidance", () => {
    expect(parseConfig({ systemPrompt: "Legacy guidance" })).toEqual({
      ...configDefaults,
      guidance: "Legacy guidance",
    });
  });

  test("rejects guidance together with its deprecated alias", () => {
    expect(() =>
      parseConfig({ guidance: "New guidance", systemPrompt: "Legacy guidance" }),
    ).toThrow("cannot contain both guidance and systemPrompt");
  });

  test("rejects duplicate setter and status tool names", () => {
    expect(() => parseConfig({ statusToolName: "set_thinking_level" })).toThrow(
      "toolName and statusToolName must be different",
    );
  });
});
