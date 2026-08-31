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
            budget: { model: "provider/global:low", hint: "Global budget hint" },
            design: { model: "provider/global:low", hint: "Global hint" },
          },
        },
      },
      projectSettings: {
        minimalSubagents: {
          maxSubagentDepth: 1,
          modelRoles: {
            deleted: null,
            budget: "provider/project:high",
            design: { model: "provider/project:high" },
          },
        },
      },
      eligibleModelIds: eligibleModels,
    });

    expect(result).toEqual({
      maxSubagentDepth: 1,
      subagentAccess: {
        enabled: true,
        source: "default",
        globalEnabled: undefined,
        projectEnabled: undefined,
      },
      modelRoles: [
        { name: "budget", model: "provider/project", thinkingLevel: "high" },
        {
          name: "design",
          model: "provider/project",
          thinkingLevel: "high",
          hint: "Global hint",
        },
      ],
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
            unknownSuffix: "provider/global:turbo",
            missing: "provider/missing:high",
            valid: "provider/global",
          },
        },
      },
      eligibleModelIds: eligibleModels,
    });
    expect(result.maxSubagentDepth).toBe(3);
    expect(result.subagentAccess).toEqual({
      enabled: true,
      source: "default",
      globalEnabled: undefined,
      projectEnabled: undefined,
    });
    expect(result.modelRoles).toEqual([{ name: "valid", model: "provider/global" }]);
    expect(result.warnings).toEqual([
      "project minimalSubagents.maxSubagentDepth: expected a positive safe integer or null",
      "project minimalSubagents.modelRoles.unknownSuffix: unknown thinking level suffix: turbo",
      "project minimalSubagents.modelRoles.missing: model is not eligible: provider/missing:high",
    ]);
  });

  it("resolves all thinking levels in shorthand and expanded role forms", () => {
    const result = resolveMinimalSubagentsConfig({
      globalSettings: {
        minimalSubagents: {
          modelRoles: {
            shorthandOff: "provider/shorthand:off",
            shorthandLow: "provider/shorthand:low",
            shorthandMedium: "provider/shorthand:medium",
            shorthandMax: "provider/shorthand:max",
            expandedMinimal: { model: "provider/expanded:minimal" },
            expandedHigh: { model: "provider/expanded:high", hint: "Use for visual polish" },
            expandedXhigh: { model: "provider/expanded:xhigh" },
          },
        },
      },
      projectSettings: {},
      eligibleModelIds: ["provider/shorthand", "provider/expanded"],
    });

    expect(result).toEqual({
      maxSubagentDepth: 2,
      subagentAccess: {
        enabled: true,
        source: "default",
        globalEnabled: undefined,
        projectEnabled: undefined,
      },
      modelRoles: [
        { name: "shorthandOff", model: "provider/shorthand", thinkingLevel: "off" },
        { name: "shorthandLow", model: "provider/shorthand", thinkingLevel: "low" },
        { name: "shorthandMedium", model: "provider/shorthand", thinkingLevel: "medium" },
        { name: "shorthandMax", model: "provider/shorthand", thinkingLevel: "max" },
        { name: "expandedMinimal", model: "provider/expanded", thinkingLevel: "minimal" },
        {
          name: "expandedHigh",
          model: "provider/expanded",
          thinkingLevel: "high",
          hint: "Use for visual polish",
        },
        { name: "expandedXhigh", model: "provider/expanded", thinkingLevel: "xhigh" },
      ],
      warnings: [],
    });
  });

  it("prefers exact eligible model IDs before interpreting a thinking suffix", () => {
    const result = resolveMinimalSubagentsConfig({
      globalSettings: {
        minimalSubagents: {
          modelRoles: {
            exactHigh: "provider/real:high",
            exactOther: { model: "provider/real:8b", hint: "Exact model" },
            preferred: "provider/base:high",
          },
        },
      },
      projectSettings: {},
      eligibleModelIds: ["provider/base", "provider/real:8b", "provider/real:high"],
    });

    expect(result).toEqual({
      maxSubagentDepth: 2,
      subagentAccess: {
        enabled: true,
        source: "default",
        globalEnabled: undefined,
        projectEnabled: undefined,
      },
      modelRoles: [
        { name: "exactHigh", model: "provider/real:high" },
        { name: "exactOther", model: "provider/real:8b", hint: "Exact model" },
        { name: "preferred", model: "provider/base", thinkingLevel: "high" },
      ],
      warnings: [],
    });
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
    ).toEqual({
      maxSubagentDepth: 2,
      subagentAccess: {
        enabled: true,
        source: "default",
        globalEnabled: undefined,
        projectEnabled: undefined,
      },
      modelRoles: [],
      warnings: [],
    });
  });

  it("reports authored access values and applies trusted project over global over default", () => {
    expect(
      resolveMinimalSubagentsConfig({
        globalSettings: { minimalSubagents: { enabled: false } },
        projectSettings: { minimalSubagents: { enabled: true } },
        eligibleModelIds: eligibleModels,
      }).subagentAccess,
    ).toEqual({
      enabled: true,
      source: "project",
      globalEnabled: false,
      projectEnabled: true,
    });

    expect(
      resolveMinimalSubagentsConfig({
        globalSettings: { minimalSubagents: { enabled: false } },
        projectSettings: {},
        eligibleModelIds: eligibleModels,
      }).subagentAccess,
    ).toEqual({
      enabled: false,
      source: "global",
      globalEnabled: false,
      projectEnabled: undefined,
    });
  });

  it("ignores invalid access booleans without disturbing valid settings", () => {
    const result = resolveMinimalSubagentsConfig({
      globalSettings: {
        minimalSubagents: { enabled: false, maxSubagentDepth: 3 },
      },
      projectSettings: {
        minimalSubagents: { enabled: "yes", maxSubagentDepth: 1 },
      },
      eligibleModelIds: eligibleModels,
    });

    expect(result.subagentAccess).toEqual({
      enabled: false,
      source: "global",
      globalEnabled: false,
      projectEnabled: undefined,
    });
    expect(result.maxSubagentDepth).toBe(1);
    expect(result.warnings).toEqual(["project minimalSubagents.enabled: expected a boolean"]);
  });

  it("omits untrusted project access while retaining global access", () => {
    const result = resolveMinimalSubagentsSettings(
      {
        getGlobalSettings: () => ({ minimalSubagents: { enabled: false } }),
        getProjectSettings: () => ({ minimalSubagents: { enabled: true } }),
        isProjectTrusted: () => false,
      },
      eligibleModels,
    );

    expect(result.subagentAccess).toEqual({
      enabled: false,
      source: "global",
      globalEnabled: false,
      projectEnabled: undefined,
    });
  });
});
