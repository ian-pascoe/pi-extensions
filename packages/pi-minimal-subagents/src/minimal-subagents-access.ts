import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { COORDINATOR_TOOL_NAMES } from "./minimal-subagents-capabilities.js";
import type {
  ResolvedSubagentAccessSettings,
  SubagentAccessSettingsSource,
} from "./minimal-subagents-config.js";

/** Names branch-scoped Root Agent Subagent Access records. */
export const SUBAGENT_ACCESS_ENTRY_TYPE = "minimal-subagents.access";

const MAX_SUBAGENT_ACCESS_DIAGNOSTICS = 5;
const SubagentAccessOverrideSchema = Type.Union([
  Type.Literal("enabled"),
  Type.Literal("disabled"),
  Type.Literal("inherit"),
]);
const SubagentAccessBranchRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    access: SubagentAccessOverrideSchema,
  },
  { additionalProperties: false },
);
const COORDINATOR_TOOL_NAME_SET = new Set<string>(COORDINATOR_TOOL_NAMES);

/** Represents desired branch-local Subagent Access, including settings inheritance. */
export type SubagentAccessOverride = Static<typeof SubagentAccessOverrideSchema>;

/** Represents the versioned custom-entry payload persisted on a Root Agent branch. */
export type SubagentAccessBranchRecord = Static<typeof SubagentAccessBranchRecordSchema>;

/** Describes one invalid branch record skipped during Subagent Access replay. */
export interface SubagentAccessReplayDiagnostic {
  entryIndex: number;
  message: string;
}

/** Contains the latest valid branch override and bounded replay diagnostics. */
export interface ReplayedSubagentAccessBranch {
  override: SubagentAccessOverride;
  diagnostics: SubagentAccessReplayDiagnostic[];
}

/** Describes actual activation of the six Root Agent Coordinator Tools. */
export interface CoordinatorToolActivation {
  activeCount: number;
  totalCount: number;
  state: "enabled" | "disabled" | "partial";
}

/** Identifies the branch or settings layer that determines effective Subagent Access. */
export type SubagentAccessSource = "branch" | SubagentAccessSettingsSource;

/** Contains desired Subagent Access, authored defaults, and actual Coordinator Tool activation. */
export interface SubagentAccessSnapshot {
  enabled: boolean;
  source: SubagentAccessSource;
  branchOverride: SubagentAccessOverride;
  globalEnabled: boolean | undefined;
  projectEnabled: boolean | undefined;
  coordinatorTools: CoordinatorToolActivation;
}

interface SubagentAccessEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Create the validated V1 payload appended for one branch-local access decision. */
export function createSubagentAccessBranchRecord(
  access: SubagentAccessOverride,
): SubagentAccessBranchRecord {
  return { version: 1, access };
}

/** Replay the latest valid Subagent Access record from the selected Root Agent branch. */
export function replaySubagentAccessBranch(
  entries: readonly SubagentAccessEntryLike[],
  reportInvalidRecords?: (diagnostics: SubagentAccessReplayDiagnostic[]) => void,
): ReplayedSubagentAccessBranch {
  let override: SubagentAccessOverride = "inherit";
  const diagnostics: SubagentAccessReplayDiagnostic[] = [];

  entries.forEach((entry, entryIndex) => {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_ACCESS_ENTRY_TYPE) return;
    if (Value.Check(SubagentAccessBranchRecordSchema, entry.data)) {
      override = entry.data.access;
      return;
    }
    if (diagnostics.length < MAX_SUBAGENT_ACCESS_DIAGNOSTICS) {
      diagnostics.push({
        entryIndex,
        message: "Subagent Access branch record is invalid and was ignored",
      });
    }
  });

  if (diagnostics.length > 0) reportInvalidRecords?.(diagnostics);
  return { override, diagnostics };
}

/** Inspect actual Coordinator Tool activation without changing active tools. */
export function inspectCoordinatorToolActivation(
  activeToolNames: readonly string[],
): CoordinatorToolActivation {
  const activeCoordinatorNames = new Set(
    activeToolNames.filter((toolName) => COORDINATOR_TOOL_NAME_SET.has(toolName)),
  );
  const activeCount = activeCoordinatorNames.size;
  return {
    activeCount,
    totalCount: COORDINATOR_TOOL_NAMES.length,
    state:
      activeCount === 0
        ? "disabled"
        : activeCount === COORDINATOR_TOOL_NAMES.length
          ? "enabled"
          : "partial",
  };
}

/** Reconcile all six Coordinator Tools while preserving unrelated active-tool order. */
export function reconcileCoordinatorToolAccess(
  activeToolNames: readonly string[],
  enabled: boolean,
): string[] {
  if (!enabled) {
    return activeToolNames.filter((toolName) => !COORDINATOR_TOOL_NAME_SET.has(toolName));
  }

  const reconciled: string[] = [];
  const includedCoordinatorNames = new Set<string>();
  for (const toolName of activeToolNames) {
    if (!COORDINATOR_TOOL_NAME_SET.has(toolName)) {
      reconciled.push(toolName);
      continue;
    }
    if (!includedCoordinatorNames.has(toolName)) {
      reconciled.push(toolName);
      includedCoordinatorNames.add(toolName);
    }
  }
  for (const coordinatorToolName of COORDINATOR_TOOL_NAMES) {
    if (!includedCoordinatorNames.has(coordinatorToolName)) reconciled.push(coordinatorToolName);
  }
  return reconciled;
}

/** Resolve branch state over settings and include read-only Coordinator Tool activation. */
export function resolveSubagentAccessSnapshot(
  settings: ResolvedSubagentAccessSettings,
  branchOverride: SubagentAccessOverride,
  activeToolNames: readonly string[],
): SubagentAccessSnapshot {
  const branchEnabled = branchOverride === "inherit" ? undefined : branchOverride === "enabled";
  return {
    enabled: branchEnabled ?? settings.enabled,
    source: branchEnabled === undefined ? settings.source : "branch",
    branchOverride,
    globalEnabled: settings.globalEnabled,
    projectEnabled: settings.projectEnabled,
    coordinatorTools: inspectCoordinatorToolActivation(activeToolNames),
  };
}
