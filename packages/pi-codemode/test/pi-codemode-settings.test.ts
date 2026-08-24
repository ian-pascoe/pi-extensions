import { describe, expect, test } from "vitest";
import { resolveCodeModeSettings } from "../src/pi-codemode-settings.js";

describe("resolveCodeModeSettings", () => {
  test("merges trusted layers by field and replaces the global tools array", () => {
    const settings = resolveCodeModeSettings({
      getGlobalSettings: () => ({
        codemode: {
          maxSessions: 3,
          tools: [{ pattern: "global_*", exposure: "codemode-only" }],
        },
      }),
      getProjectSettings: () => ({
        codemode: {
          tools: [{ pattern: "project_*", exposure: "direct-only" }],
        },
      }),
    });

    expect(settings.enabled).toBe(true);
    if (!settings.enabled) return;
    expect(settings.maxSessions).toBe(3);
    expect(settings.rules).toHaveLength(1);
    expect(settings.rules[0]).toMatchObject({
      exposure: "direct-only",
      pattern: "project_*",
    });
    expect(settings.rules[0]?.matches("project_read")).toBe(true);
    expect(settings.rules[0]?.matches("global_read")).toBe(false);
  });

  test("lets a trusted project override maxSessions while inheriting global rules", () => {
    const settings = resolveCodeModeSettings({
      getGlobalSettings: () => ({
        codemode: {
          maxSessions: 2,
          tools: [{ pattern: "bash", exposure: "direct-only" }],
        },
      }),
      getProjectSettings: () => ({ codemode: { maxSessions: 5 } }),
    });

    expect(settings.enabled).toBe(true);
    if (!settings.enabled) return;
    expect(settings.maxSessions).toBe(5);
    expect(settings.rules[0]?.pattern).toBe("bash");
  });

  test.each([
    [{ codemode: [] }, "global codemode: expected an object"],
    [{ codemode: { extra: true } }, "global codemode.extra: unknown field"],
    [
      { codemode: { maxSessions: 0 } },
      "global codemode.maxSessions: expected a positive safe integer",
    ],
    [{ codemode: { tools: {} } }, "global codemode.tools: expected an array"],
    [
      { codemode: { tools: [{ pattern: "*", exposure: "elsewhere" }] } },
      "global codemode.tools[0].exposure: expected codemode-only, direct-and-codemode, or direct-only",
    ],
    [
      { codemode: { tools: [{ pattern: "#comment", exposure: "direct-only" }] } },
      "global codemode.tools[0].pattern: invalid minimatch pattern",
    ],
    [
      {
        codemode: {
          tools: [{ pattern: "*", exposure: "direct-only", unexpected: true }],
        },
      },
      "global codemode.tools[0].unexpected: unknown field",
    ],
  ])(
    "disables CodeMode with one path-qualified warning for invalid global settings",
    (global, warning) => {
      expect(
        resolveCodeModeSettings({
          getGlobalSettings: () => global,
          getProjectSettings: () => ({}),
        }),
      ).toEqual({ enabled: false, warning });
    },
  );

  test("qualifies invalid project settings without falling back to the global layer", () => {
    expect(
      resolveCodeModeSettings({
        getGlobalSettings: () => ({ codemode: { maxSessions: 2 } }),
        getProjectSettings: () => ({ codemode: { maxSessions: 1.5 } }),
      }),
    ).toEqual({
      enabled: false,
      warning: "project codemode.maxSessions: expected a positive safe integer",
    });
  });
});
