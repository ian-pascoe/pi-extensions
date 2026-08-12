import { describe, expect, it } from "vitest";
import {
  resolveMinimalSubagentsConfig,
  resolveMinimalSubagentsSettings,
} from "../src/minimal-subagents-config.js";

const eligibleModels = ["provider/global", "provider/project"];

describe("minimal subagents configuration", () => {
  it("merges expanded project roles, deletes inherited roles, and applies project depth", () => {
    const result = resolveMinimalSubagentsConfig({
      globalSettings: {
        minimalSubagents: {
          maxSubagentDepth: 4,
          modelRoles: {
            deleted: "provider/global",
            design: { model: "provider/global", hint: "Global hint" },
          },
        },
      },
      projectSettings: {
        minimalSubagents: {
          maxSubagentDepth: 1,
          modelRoles: {
            deleted: null,
            design: { model: "provider/project" },
          },
        },
      },
      eligibleModelIds: eligibleModels,
    });

    expect(result).toEqual({
      maxSubagentDepth: 1,
      modelRoles: [{ name: "design", model: "provider/project", hint: "Global hint" }],
      warnings: [],
    });
  });

  it("uses defaults and preserves a valid global value when project settings are invalid", () => {
    const result = resolveMinimalSubagentsConfig({
      globalSettings: { minimalSubagents: { maxSubagentDepth: 3 } },
      projectSettings: {
        minimalSubagents: {
          maxSubagentDepth: 0,
          modelRoles: {
            suffix: "provider/global:high",
            missing: "provider/missing",
            valid: "provider/global",
          },
        },
      },
      eligibleModelIds: eligibleModels,
    });
    expect(result.maxSubagentDepth).toBe(3);
    expect(result.modelRoles).toEqual([{ name: "valid", model: "provider/global" }]);
    expect(result.warnings).toEqual([
      "project minimalSubagents.maxSubagentDepth: expected a positive safe integer or null",
      "project minimalSubagents.modelRoles.suffix: thinking level suffixes are not allowed; choose thinking_level per spawn",
      "project minimalSubagents.modelRoles.missing: model is not eligible: provider/missing",
    ]);
  });

  it("reads the trust-aware settings layers and lets project null restore defaults", () => {
    expect(
      resolveMinimalSubagentsSettings(
        {
          getGlobalSettings: () => ({ minimalSubagents: { maxSubagentDepth: 9 } }),
          getProjectSettings: () => ({
            minimalSubagents: { maxSubagentDepth: null, modelRoles: null },
          }),
        },
        eligibleModels,
      ),
    ).toEqual({ maxSubagentDepth: 2, modelRoles: [], warnings: [] });
  });
});
