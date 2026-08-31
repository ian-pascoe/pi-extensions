import type { JsonValue } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COORDINATOR_TOOL_NAMES } from "../src/minimal-subagents-capabilities.js";
import {
  createSubagentAccessBranchRecord,
  inspectCoordinatorToolActivation,
  reconcileCoordinatorToolAccess,
  replaySubagentAccessBranch,
  resolveSubagentAccessSnapshot,
  SUBAGENT_ACCESS_ENTRY_TYPE,
  type SubagentAccessReplayDiagnostic,
} from "../src/minimal-subagents-access.js";

function accessEntry(data: JsonValue) {
  return { type: "custom" as const, customType: SUBAGENT_ACCESS_ENTRY_TYPE, data };
}

describe("Subagent Access branch state", () => {
  it("treats an absent branch record as inherited settings", () => {
    expect(replaySubagentAccessBranch([])).toEqual({ override: "inherit", diagnostics: [] });
  });

  it("replays only the latest valid selected-branch record", () => {
    const branch = [
      accessEntry(createSubagentAccessBranchRecord("enabled")),
      accessEntry({ version: 1, access: "unknown" }),
      accessEntry(createSubagentAccessBranchRecord("disabled")),
      accessEntry(createSubagentAccessBranchRecord("inherit")),
    ];

    expect(replaySubagentAccessBranch(branch)).toEqual({
      override: "inherit",
      diagnostics: [
        {
          entryIndex: 1,
          message: "Subagent Access branch record is invalid and was ignored",
        },
      ],
    });
    expect(replaySubagentAccessBranch(branch.slice(0, 3)).override).toBe("disabled");
  });

  it("keeps sibling branch overrides independent", () => {
    const common = [accessEntry(createSubagentAccessBranchRecord("enabled"))];
    const left = [...common, accessEntry(createSubagentAccessBranchRecord("disabled"))];
    const right = [...common, accessEntry(createSubagentAccessBranchRecord("inherit"))];

    expect(replaySubagentAccessBranch(left).override).toBe("disabled");
    expect(replaySubagentAccessBranch(right).override).toBe("inherit");
  });

  it("bounds invalid-record diagnostics without hiding the valid state", () => {
    const reported: SubagentAccessReplayDiagnostic[][] = [];
    const branch = Array.from({ length: 20 }, (_, index) => accessEntry({ version: index }));
    branch.push(accessEntry(createSubagentAccessBranchRecord("disabled")));

    const replay = replaySubagentAccessBranch(branch, (diagnostics) => reported.push(diagnostics));

    expect(replay.override).toBe("disabled");
    expect(replay.diagnostics).toHaveLength(5);
    expect(reported).toEqual([replay.diagnostics]);
  });
});

describe("Subagent Access resolution", () => {
  const settings = {
    enabled: false,
    source: "project" as const,
    globalEnabled: true,
    projectEnabled: false,
  };

  it("applies branch overrides before project, global, and default settings", () => {
    expect(resolveSubagentAccessSnapshot(settings, "enabled", []).enabled).toBe(true);
    expect(resolveSubagentAccessSnapshot(settings, "enabled", []).source).toBe("branch");
    expect(resolveSubagentAccessSnapshot(settings, "inherit", []).enabled).toBe(false);
    expect(resolveSubagentAccessSnapshot(settings, "inherit", []).source).toBe("project");
  });

  it("reports authored settings and partial Coordinator Tool activation without repairing it", () => {
    expect(resolveSubagentAccessSnapshot(settings, "inherit", ["read", "subagent"])).toEqual({
      enabled: false,
      source: "project",
      branchOverride: "inherit",
      globalEnabled: true,
      projectEnabled: false,
      coordinatorTools: {
        activeCount: 1,
        totalCount: 6,
        state: "partial",
      },
    });
  });
});

describe("Coordinator Tool access", () => {
  it("reports disabled, partial, and enabled activation", () => {
    expect(inspectCoordinatorToolActivation(["read"])).toEqual({
      activeCount: 0,
      totalCount: 6,
      state: "disabled",
    });
    expect(inspectCoordinatorToolActivation(["read", "subagent"])).toEqual({
      activeCount: 1,
      totalCount: 6,
      state: "partial",
    });
    expect(inspectCoordinatorToolActivation([...COORDINATOR_TOOL_NAMES])).toEqual({
      activeCount: 6,
      totalCount: 6,
      state: "enabled",
    });
  });

  it("reconciles access idempotently while preserving unrelated tool names and order", () => {
    const coordinatorNames = new Set<string>(COORDINATOR_TOOL_NAMES);
    const ordinaryToolName = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter((name) => !coordinatorNames.has(name));

    fc.assert(
      fc.property(
        fc.uniqueArray(ordinaryToolName, { maxLength: 20 }),
        fc.boolean(),
        (ordinaryTools, enabled) => {
          const interleaved = ordinaryTools.flatMap((name, index) => {
            const coordinatorToolName =
              COORDINATOR_TOOL_NAMES[index % COORDINATOR_TOOL_NAMES.length];
            return index % 2 === 0 && coordinatorToolName !== undefined
              ? [name, coordinatorToolName]
              : [name];
          });
          const reconciled = reconcileCoordinatorToolAccess(interleaved, enabled);
          const repeated = reconcileCoordinatorToolAccess(reconciled, enabled);

          expect(repeated).toEqual(reconciled);
          expect(reconciled.filter((name) => !coordinatorNames.has(name))).toEqual(ordinaryTools);
          expect(reconciled.filter((name) => coordinatorNames.has(name))).toHaveLength(
            enabled ? 6 : 0,
          );
          if (enabled) {
            expect(new Set(reconciled.filter((name) => coordinatorNames.has(name)))).toEqual(
              coordinatorNames,
            );
          }
        },
      ),
    );
  });
});
